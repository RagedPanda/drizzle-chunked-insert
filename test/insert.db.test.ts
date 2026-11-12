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
import {ChunkedInsertError, insertInChunks, planChunks, RowTooLargeError} from '../src/index.ts';

const users = sqliteTable('users', {id: integer('id').primaryKey(), name: text('name').notNull()});
const pgUsers = pgTable('users', {id: pgInteger('id').primaryKey(), name: pgText('name').notNull()});
const createUsers = sql`create table users (id integer primary key, name text not null)`;
const people = (from: number, to: number) => Array.from({length: to - from}, (_, index) => ({id: from + index, name: `user ${from + index}`}));
// Row 0 again, so the chunk holding it fails on the primary key.
const withDuplicateAtEnd = (total: number) => [...people(0, total - 1), {id: 0, name: 'duplicate'}];

// drizzle 1.0 wraps driver errors in DrizzleQueryError, so match the innermost cause's message.
function rootMessage(error: unknown): string {
	const {cause} = error as {cause?: unknown};
	return cause instanceof Error ? rootMessage(cause) : String((error as Error).message);
}

const failsWith = (pattern: RegExp) => (error: unknown) => pattern.test(rootMessage(error));

function betterSqlite() {
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	db.run(createUsers);
	return db;
}

async function pglite() {
	const db = pgliteDrizzle({client: new PGlite()});
	await db.execute(createUsers);
	return db;
}

async function libsql() {
	const db = libsqlDrizzle({client: createClient({url: ':memory:'})});
	await db.run(createUsers);
	return db;
}

async function d1(t: {after: (run: () => Promise<void>) => void}) {
	const miniflare = new Miniflare({modules: true, script: 'export default {}', d1Databases: ['DB']});
	t.after(() => miniflare.dispose());
	const db = d1Drizzle(await miniflare.getD1Database('DB') as never);
	await db.run(createUsers);
	return db;
}

test('better-sqlite3: 40,000 rows go in as chunks of 16,383, the most 32,766 parameters allow', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	const rows = people(0, 40_000);
	assert.deepEqual(planChunks(db, users, rows).map(chunk => chunk.length), [16_383, 16_383, 7234]);
	await insertInChunks(db, users, rows);
	assert.deepEqual(db.select({total: count()}).from(users).all(), [{total: 40_000}]);
});

test('better-sqlite3: a failing chunk rolls back the chunks before it', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	await assert.rejects(insertInChunks(db, users, withDuplicateAtEnd(50), {maxParams: 20}), failsWith(/UNIQUE constraint failed/));
	assert.deepEqual(db.select({total: count()}).from(users).all(), [{total: 0}]);
});

test('better-sqlite3: returning() rows come back in input order across chunks', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	const inserted = await insertInChunks(db, people(0, 25), (tx, chunk) => tx.insert(users).values(chunk).returning({id: users.id}), {maxParams: 10});
	assert.deepEqual(inserted, people(0, 25).map(({id}) => ({id})));
});

test('better-sqlite3: with atomic false, a failure says how far it got and keeps those rows', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	db.insert(users).values({id: 33, name: 'taken'}).run();
	const failure = await insertInChunks(db, users, people(0, 50), {maxParams: 20, atomic: false}).catch((error: unknown) => error);
	assert.ok(failure instanceof ChunkedInsertError);
	assert.deepEqual([failure.insertedRows, failure.failedChunk], [30, 3]);
	assert.match(rootMessage(failure.cause), /UNIQUE constraint failed/);
	assert.deepEqual(db.select({total: count()}).from(users).all(), [{total: 31}]);
});

test('better-sqlite3: inside a caller transaction it runs in that transaction', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	assert.throws(() => db.transaction(tx => {
		void insertInChunks(tx, users, people(0, 30), {maxParams: 20});
		assert.deepEqual(tx.select({total: count()}).from(users).all(), [{total: 30}]);
		tx.rollback();
	}), /Rollback/);
	assert.deepEqual(db.select({total: count()}).from(users).all(), [{total: 0}]);
});

test('PGlite: chunks run in one transaction and roll back together', async t => {
	const db = await pglite();
	t.after(() => db.$client.close());
	await assert.rejects(insertInChunks(db, pgUsers, withDuplicateAtEnd(50), {maxParams: 20}), failsWith(/duplicate key/));
	assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 0}]);

	await insertInChunks(db, pgUsers, people(0, 50), {maxParams: 20});
	assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 50}]);
});

test('PGlite: an upsert set clause shrinks each chunk by a row, not by half', async t => {
	const db = await pglite();
	t.after(() => db.$client.close());
	const build = (tx: typeof db, chunk: Array<typeof pgUsers.$inferInsert>) => tx.insert(pgUsers).values(chunk)
		.onConflictDoUpdate({target: pgUsers.id, set: {name: sql`excluded.name || ${'!'}`}})
		.returning({id: pgUsers.id, name: pgUsers.name});
	assert.deepEqual(planChunks(db, people(0, 40), build, {maxParams: 20}).map(chunk => chunk.length), [9, 9, 9, 9, 4]);
	await insertInChunks(db, people(0, 40), build, {maxParams: 20});
	const updated = await insertInChunks(db, people(0, 40), build, {maxParams: 20});
	assert.deepEqual(updated, people(0, 40).map(({id, name}) => ({id, name: `${name}!`})));
});

test('PGlite: inside a caller transaction it runs in that transaction', async t => {
	const db = await pglite();
	t.after(() => db.$client.close());
	await assert.rejects(db.transaction(async tx => {
		await insertInChunks(tx, pgUsers, people(0, 30), {maxParams: 20});
		tx.rollback();
	}), /Rollback/);
	assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 0}]);
});

test('libsql: chunks run in one batch and roll back together', async t => {
	const db = await libsql();
	t.after(() => db.$client.close());
	await assert.rejects(insertInChunks(db, users, withDuplicateAtEnd(50), {maxParams: 20}));
	assert.deepEqual(await db.select({total: count()}).from(users), [{total: 0}]);

	const inserted = await insertInChunks(db, people(0, 50), (tx, chunk) => tx.insert(users).values(chunk).returning({id: users.id}), {maxParams: 20});
	assert.deepEqual(inserted, people(0, 50).map(({id}) => ({id})));
});

test('D1: chunks stay under 100 parameters and run in one batch', async t => {
	const db = await d1(t);
	assert.deepEqual(planChunks(db, users, people(0, 120)).map(chunk => chunk.length), [50, 50, 20]);
	await assert.rejects(insertInChunks(db, users, withDuplicateAtEnd(120)));
	assert.deepEqual(await db.select({total: count()}).from(users), [{total: 0}]);

	await insertInChunks(db, users, people(0, 120));
	assert.deepEqual(await db.select({total: count()}).from(users), [{total: 120}]);
});

test('zero rows run nothing and resolve to []', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	assert.deepEqual(await insertInChunks(db, users, []), []);
	assert.deepEqual(planChunks(db, users, []), []);
});

test('a row too large for the limits fails before any chunk runs', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	const rows = [...people(0, 10), {id: 10, name: 'x'.repeat(500)}];
	const build = (tx: typeof db, chunk: typeof rows) => tx.insert(users).values(chunk.map(row => ({id: row.id, name: sql.raw(`'${row.name}'`)})));
	await assert.rejects(insertInChunks(db, rows, build, {maxSqlLength: 300, atomic: false}), RowTooLargeError);
	assert.deepEqual(db.select({total: count()}).from(users).all(), [{total: 0}]);
});

test('a single chunk runs as one statement and fails with the driver\'s own error', async t => {
	const db = betterSqlite();
	t.after(() => db.$client.close());
	assert.deepEqual(await insertInChunks(db, [{id: 1, name: 'one'}], (tx, chunk) => tx.insert(users).values(chunk).returning({id: users.id})), [{id: 1}]);
	const failure = await insertInChunks(db, users, [{id: 1, name: 'again'}]).catch((error: unknown) => error);
	assert.ok(!(failure instanceof ChunkedInsertError));
	assert.match(rootMessage(failure), /UNIQUE constraint failed/);
});
