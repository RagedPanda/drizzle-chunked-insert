import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createClient} from '@libsql/client';
import Database from 'better-sqlite3';
import {count, sql} from 'drizzle-orm';
import {drizzle as betterSqliteDrizzle} from 'drizzle-orm/better-sqlite3';
import {drizzle as d1Drizzle} from 'drizzle-orm/d1';
import {drizzle as libsqlDrizzle} from 'drizzle-orm/libsql';
import {integer as pgInteger, pgTable, text as pgText} from 'drizzle-orm/pg-core';
import {drizzle as pgliteDrizzle} from 'drizzle-orm/pglite';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {Miniflare} from 'miniflare';
import {ChunkedInsertError, insertInChunks, planChunks} from '../src/index.ts';

const notes = sqliteTable('notes', {id: integer('id').primaryKey(), body: text('body'), tag: text('tag').$defaultFn(() => 'default')});
const pgNotes = pgTable('notes', {id: pgInteger('id').primaryKey(), body: pgText('body'), tag: pgText('tag').default('default')});
const createNotes = sql`create table notes (id integer primary key, body text, tag text)`;
// Every other row sets `body`, so rows compile to different numbers of parameters.
const mixedRows = (total: number) => Array.from({length: total}, (_, id) => id % 2 === 0 ? {id} : {id, body: `body ${id}`});
const totalParams = (chunk: ReadonlyArray<{body?: string | null | undefined}>) => chunk.reduce((sum, row) => sum + (row.body === undefined ? 2 : 3), 0);

function betterSqlite() {
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	db.run(createNotes);
	return db;
}

test('limits that are not positive whole numbers throw a RangeError before anything runs', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	for (const options of [{maxParams: 0}, {maxParams: Number.NaN}, {maxRows: 1.5}, {maxRows: -1}, {maxSqlLength: Number.POSITIVE_INFINITY}]) {
		await assert.rejects(insertInChunks(db, notes, mixedRows(10), options), RangeError);
		assert.throws(() => planChunks(db, notes, [], options), RangeError);
	}

	assert.deepEqual(db.select({total: count()}).from(notes).all(), [{total: 0}]);
});

test('rows of different shapes each get chunks that fit, on SQLite and Postgres', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	const rows = mixedRows(100);
	const chunks = planChunks(db, notes, rows, {maxParams: 25});
	assert.ok(chunks.every(chunk => totalParams(chunk) <= 25));
	assert.deepEqual(chunks.flat(), rows);
	await insertInChunks(db, notes, rows, {maxParams: 25});
	assert.deepEqual(db.select({total: count()}).from(notes).all(), [{total: 100}]);

	const pg = pgliteDrizzle({client: new PGlite()});
	t.after(() => pg.$client.close());
	await pg.execute(createNotes);
	await insertInChunks(pg, pgNotes, rows, {maxParams: 25});
	assert.deepEqual(await pg.select({total: count()}).from(pgNotes), [{total: 100}]);
});

test('$defaultFn values come from the statement that ran, not from planning', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	let calls = 0;
	const stamped = sqliteTable('notes', {id: integer('id').primaryKey(), body: text('body'), tag: text('tag').$defaultFn(() => `call ${++calls}`)});
	await insertInChunks(db, stamped, mixedRows(30), {maxParams: 20});
	const tags = db.select({tag: stamped.tag}).from(stamped).all().map(row => row.tag);
	assert.equal(new Set(tags).size, 30);
	// Planning compiles chunks too, so $defaultFn runs more often than once per row.
	assert.ok(calls > 30);
});

test('upserts that skip conflicts return only the rows they inserted', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	db.insert(notes).values([{id: 1}, {id: 2}]).run();
	const inserted = await insertInChunks(db, [{id: 1}, {id: 10}, {id: 2}, {id: 11}], (tx, chunk) => tx.insert(notes).values(chunk).onConflictDoNothing().returning({id: notes.id}), {maxParams: 4});
	assert.deepEqual(inserted, [{id: 10}, {id: 11}]);
});

test('with atomic false, returning() rows still come back in order', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	const inserted = await insertInChunks(db, mixedRows(9), (tx, chunk) => tx.insert(notes).values(chunk).returning({id: notes.id}), {maxParams: 6, atomic: false});
	assert.deepEqual(inserted, mixedRows(9).map(({id}) => ({id})));
});

test('with atomic false inside a caller transaction, a failure says how far it got', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	db.insert(notes).values({id: 7}).run();
	let failure: Promise<unknown> = Promise.resolve();
	// better-sqlite3's transaction callback is synchronous, and so are the chunks run inside it.
	db.transaction(tx => {
		failure = insertInChunks(tx, notes, mixedRows(10), {maxRows: 3, atomic: false}).catch((error: unknown) => error);
	});
	const error = await failure;
	assert.ok(error instanceof ChunkedInsertError);
	assert.deepEqual([error.insertedRows, error.failedChunk], [6, 2]);
	// The caller's transaction committed the chunks before the failed one.
	assert.deepEqual(db.select({total: count()}).from(notes).all(), [{total: 7}]);
});

test('libsql: inside a caller transaction it rolls back with that transaction', async t => {
	const db = libsqlDrizzle({client: createClient({url: ':memory:'})});
	t.after(() => db.$client.close());
	await db.run(createNotes);
	await assert.rejects(db.transaction(async tx => {
		await insertInChunks(tx, notes, mixedRows(50), {maxParams: 20});
		assert.deepEqual(await tx.select({total: count()}).from(notes), [{total: 50}]);
		tx.rollback();
	}), /Rollback/);
	assert.deepEqual(await db.select({total: count()}).from(notes), [{total: 0}]);
});

test('D1: returning() rows come back across the batch, and long SQL shrinks chunks by length', async t => {
	const miniflare = new Miniflare({modules: true, script: 'export default {}', d1Databases: ['DB']});
	t.after(() => miniflare.dispose());
	const db = d1Drizzle(await miniflare.getD1Database('DB') as never);
	await db.run(createNotes);
	const inserted = await insertInChunks(db, mixedRows(120), (tx, chunk) => tx.insert(notes).values(chunk).returning({id: notes.id}));
	assert.deepEqual(inserted, mixedRows(120).map(({id}) => ({id})));

	// 2,000 bytes of inlined SQL per row: 50 rows fit D1's 100 parameters but not its 100,000-byte statements.
	const long = Array.from({length: 120}, (_, index) => ({id: 1000 + index, body: 'y'.repeat(2000)}));
	const build = (tx: typeof db, chunk: typeof long) => tx.insert(notes).values(chunk.map(row => ({id: row.id, body: sql.raw(`'${row.body}'`)})));
	assert.deepEqual(planChunks(db, long, build).map(chunk => chunk.length), [49, 49, 22]);
	await insertInChunks(db, long, build);
	assert.deepEqual(await db.select({total: count()}).from(notes), [{total: 240}]);
});

// Before drizzle 1.0, a single values() call with this many rows overflows the call stack (drizzle-orm#1740).
test('200,000 rows go in', async t => {
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	t.after(() => db.$client.close());
	const ids = sqliteTable('ids', {id: integer('id').primaryKey()});
	db.run(sql`create table ids (id integer primary key)`);
	const rows = Array.from({length: 200_000}, (_, id) => ({id}));
	await insertInChunks(db, ids, rows);
	assert.deepEqual(db.select({total: count()}).from(ids).all(), [{total: 200_000}]);
});

test('the input array is left as it was, and a frozen array works', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	const rows = Object.freeze(mixedRows(20).map(row => Object.freeze(row)));
	const before = JSON.stringify(rows);
	await insertInChunks(db, notes, rows, {maxRows: 7});
	assert.equal(JSON.stringify(rows), before);
	assert.deepEqual(planChunks(db, notes, rows, {maxRows: 7}).map(chunk => chunk.length), [7, 7, 6]);
});

test('a row that needs exactly maxParams parameters fits on its own', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	assert.deepEqual(planChunks(db, notes, [{id: 1, body: 'a'}, {id: 2, body: 'b'}], {maxParams: 3}).map(chunk => chunk.length), [1, 1]);
});

test('a counted plan the first rows contradict falls back to measuring every chunk', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	// $defaultFn returning `sql` binds two parameters where counting assumes one.
	const tagged = sqliteTable('notes', {id: integer('id').primaryKey(), body: text('body'), tag: text('tag').$defaultFn(() => sql`${'a'} || ${'b'}` as unknown as string)});
	const rows = Array.from({length: 10}, (_, id) => ({id}));
	assert.deepEqual(planChunks(db, tagged, rows, {maxParams: 9}).map(chunk => chunk.length), [3, 3, 3, 1]);
	await insertInChunks(db, tagged, rows, {maxParams: 9});
	assert.deepEqual(db.select({total: count()}).from(notes).all(), [{total: 10}]);
});

test('a table insert with sql values is planned by measuring', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	// Each row binds four: the id, two in `body` and the $defaultFn tag.
	const rows = Array.from({length: 10}, (_, id) => ({id, body: sql`${'x'} || ${String(id)}` as unknown as string}));
	assert.deepEqual(planChunks(db, notes, rows, {maxParams: 9}).map(chunk => chunk.length), [2, 2, 2, 2, 2]);
});
