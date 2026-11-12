import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createClient} from '@libsql/client';
import Database from 'better-sqlite3';
import {sql} from 'drizzle-orm';
import {drizzle as betterSqliteDrizzle} from 'drizzle-orm/better-sqlite3';
import {drizzle as d1Drizzle} from 'drizzle-orm/d1';
import {drizzle as libsqlDrizzle} from 'drizzle-orm/libsql';
import {integer as pgInteger, pgTable, serial, text as pgText} from 'drizzle-orm/pg-core';
import {drizzle as pgliteDrizzle} from 'drizzle-orm/pglite';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {Miniflare} from 'miniflare';

// The facts the chunk planner relies on, measured on the real drivers. If a driver or drizzle
// release changes one of them, this file fails before the planner silently goes wrong.
const one = sqliteTable('one', {value: integer('value')});
const pgOne = pgTable('one', {value: pgInteger('value')});
const rows = (count: number) => Array.from({length: count}, (_, index) => ({value: index}));

function failureMessage(error: unknown): string {
	const {message, cause} = error as Error & {cause?: Error};
	return cause?.message ?? message;
}

test('D1 allows 100 bound parameters and 100,000-byte statements', async t => {
	const miniflare = new Miniflare({modules: true, script: 'export default {}', d1Databases: ['DB']});
	t.after(() => miniflare.dispose());
	const db = d1Drizzle(await miniflare.getD1Database('DB') as never);
	await db.run(sql`create table one (value integer)`);

	await db.insert(one).values(rows(100));
	await assert.rejects(db.insert(one).values(rows(101)), error => /too many SQL variables/.test(failureMessage(error)));

	// `select 1 ` is 9 bytes and each comment 5, so these statements are 99,959 and 100,059 bytes long.
	await db.run(sql.raw(`select 1 ${'/*x*/'.repeat(19_990)}`));
	await assert.rejects(db.run(sql.raw(`select 1 ${'/*x*/'.repeat(20_010)}`)), error => /statement too long/.test(failureMessage(error)));
});

test('better-sqlite3, libsql and node:sqlite allow 32,766 bound parameters', async t => {
	const betterSqlite = betterSqliteDrizzle({client: new Database(':memory:')});
	t.after(() => betterSqlite.$client.close());
	betterSqlite.run(sql`create table one (value integer)`);
	betterSqlite.insert(one).values(rows(32_766)).run();
	assert.throws(() => betterSqlite.insert(one).values(rows(32_767)).run(), error => /too many SQL variables/.test(failureMessage(error)));

	const libsql = libsqlDrizzle({client: createClient({url: ':memory:'})});
	t.after(() => libsql.$client.close());
	await libsql.run(sql`create table one (value integer)`);
	await libsql.insert(one).values(rows(32_766));
	await assert.rejects(libsql.insert(one).values(rows(32_767)), error => /too many SQL variables/.test(failureMessage(error)));

	// drizzle's node:sqlite driver only exists from 1.0, so this measures the client directly.
	const nodeSqlite = new DatabaseSync(':memory:');
	t.after(() => nodeSqlite.close());
	nodeSqlite.exec('create table one (value integer)');
	const insertMany = (count: number) => nodeSqlite.prepare(`insert into one values ${Array(count).fill('(?)').join(',')}`).run(...Array(count).fill(1));
	insertMany(32_766);
	assert.throws(() => insertMany(32_767), /too many SQL variables/);
});

test('Postgres allows 65,535 bound parameters and wraps the count above that', async t => {
	const db = pgliteDrizzle({client: new PGlite()});
	t.after(() => db.$client.close());
	await db.execute(sql`create table one (value integer)`);
	await db.insert(pgOne).values(rows(65_535));
	// The bind message stores the count in 16 bits, so 65,536 reads as 0 and 100,000 as 34,464.
	await assert.rejects(db.insert(pgOne).values(rows(65_536)), error => /bind message supplies 0 parameters/.test(failureMessage(error)));
});

test('drizzle binds one parameter per present value and inlines missing ones', () => {
	const notes = sqliteTable('notes', {id: integer('id').primaryKey(), title: text('title'), tag: text('tag').default('none')});
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	const query = db.insert(notes).values([{id: 1, title: 'a'}, {id: 2, title: 'b', tag: 'x'}]).toSQL();
	assert.equal(query.sql, 'insert into "notes" ("id", "title", "tag") values (?, ?, ?), (?, ?, ?)');
	assert.deepEqual(query.params, [1, 'a', 'none', 2, 'b', 'x']);

	const missing = db.insert(notes).values([{id: 1}]).toSQL();
	assert.equal(missing.sql, 'insert into "notes" ("id", "title", "tag") values (?, null, ?)');

	const pgNotes = pgTable('notes', {id: serial('id').primaryKey(), title: pgText('title')});
	const pg = pgliteDrizzle({client: new PGlite()});
	assert.equal(pg.insert(pgNotes).values([{title: 'a'}]).toSQL().sql, 'insert into "notes" ("id", "title") values (default, $1)');
});

test('a transaction has rollback() and the database does not, and SQLite says when it is synchronous', () => {
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	assert.equal('rollback' in db, false);
	// resultKind is private in drizzle's types, but every version since 0.36 sets it.
	assert.equal((db as unknown as {resultKind: string}).resultKind, 'sync');
	const result = db.transaction(tx => {
		assert.equal(typeof tx.rollback, 'function');
		return 'done';
	});
	assert.equal(result, 'done');
});

test('drizzle compiles 100,000 single-value rows in one statement', () => {
	// Larger inserts overflow the call stack while building the SQL, far above any driver limit.
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	assert.equal(db.insert(one).values(rows(100_000)).toSQL().params.length, 100_000);
});
