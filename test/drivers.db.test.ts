import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {after, before, describe, test} from 'node:test';
import {count, sql} from 'drizzle-orm';
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import {int, mysqlTable, text as mysqlText} from 'drizzle-orm/mysql-core';
import {drizzle as mysql2Drizzle, type MySql2Database} from 'drizzle-orm/mysql2';
import {drizzle as nodePostgresDrizzle} from 'drizzle-orm/node-postgres';
import {integer, type PgDatabase, type PgQueryResultHKT, pgTable, text} from 'drizzle-orm/pg-core';
import {drizzle as postgresJsDrizzle} from 'drizzle-orm/postgres-js';
import {integer as sqliteInteger, sqliteTable, text as sqliteText} from 'drizzle-orm/sqlite-core';
import mysql from 'mysql2/promise';
import pg from 'pg';
import postgres from 'postgres';
import {ChunkedInsertError, insertInChunks, planChunks} from '../src/index.ts';

const pgUsers = pgTable('chunked_users', {id: integer('id').primaryKey(), name: text('name').notNull()});
const sqliteUsers = sqliteTable('users', {id: sqliteInteger('id').primaryKey(), name: sqliteText('name').notNull()});
const mysqlUsers = mysqlTable('chunked_users', {id: int('id').primaryKey(), name: mysqlText('name').notNull()});
const people = (from: number, to: number) => Array.from({length: to - from}, (_, index) => ({id: from + index, name: `user ${from + index}`}));
const withDuplicateAtEnd = (total: number) => [...people(0, total - 1), {id: 0, name: 'duplicate'}];

// drizzle 1.0 wraps driver errors in DrizzleQueryError, so match the innermost cause's message.
function rootMessage(error: unknown): string {
	const {cause} = error as {cause?: unknown};
	return cause instanceof Error ? rootMessage(cause) : String((error as Error).message);
}

const failsWith = (pattern: RegExp) => (error: unknown) => pattern.test(rootMessage(error));

type PgDb = PgDatabase<PgQueryResultHKT>;

const postgresDrivers: Array<{name: string; chunks: number[]; open: (url: string) => {db: PgDb; close: () => Promise<void>}}> = [
	{name: 'node-postgres', chunks: [32_767, 32_767, 4466], open(url) {
		const pool = new pg.Pool({connectionString: url, max: 1});
		return {db: nodePostgresDrizzle({client: pool}), close: () => pool.end()};
	}},
	// postgres.js stops at 65,533 parameters, two below the server.
	{name: 'postgres.js', chunks: [32_766, 32_766, 4468], open(url) {
		const client = postgres(url, {max: 1, onnotice: () => {}});
		return {db: postgresJsDrizzle({client}), close: () => client.end()};
	}},
];

// Postgres and MySQL need servers, so these run in CI against its services, or locally with
// DATABASE_URL or MYSQL_URL set. PGlite's socket server drops the connection after a failed query.
for (const driver of postgresDrivers) {
	describe(driver.name, {skip: process.env.DATABASE_URL ? false : 'set DATABASE_URL to run'}, () => {
		let db: PgDb;
		let close: () => Promise<void>;
		const resetTable = async () => {
			await db.execute(sql`drop table if exists chunked_users`);
			await db.execute(sql`create table chunked_users (id integer primary key, name text not null)`);
		};

		before(() => {
			({db, close} = driver.open(process.env.DATABASE_URL!));
		});
		after(() => close());

		test(`70,000 rows go in as chunks of ${driver.chunks[0]}, the most the driver allows`, async () => {
			await resetTable();
			const rows = people(0, 70_000);
			assert.deepEqual(planChunks(db, pgUsers, rows).map(chunk => chunk.length), driver.chunks);
			await insertInChunks(db, pgUsers, rows);
			assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 70_000}]);
		});

		test('a failing chunk rolls back the chunks before it', async () => {
			await resetTable();
			await assert.rejects(insertInChunks(db, pgUsers, withDuplicateAtEnd(50), {maxParams: 20}), failsWith(/duplicate key/));
			assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 0}]);
		});

		test('upsert returning() rows come back in input order across chunks', async () => {
			await resetTable();
			const build = (tx: PgDb, chunk: Array<typeof pgUsers.$inferInsert>) => tx.insert(pgUsers).values(chunk)
				.onConflictDoUpdate({target: pgUsers.id, set: {name: sql`excluded.name || ${'!'}`}})
				.returning({id: pgUsers.id, name: pgUsers.name});
			await insertInChunks(db, people(0, 40), build, {maxParams: 20});
			assert.deepEqual(await insertInChunks(db, people(0, 40), build, {maxParams: 20}), people(0, 40).map(({id, name}) => ({id, name: `${name}!`})));
		});

		test('with atomic false, a failure says how far it got and keeps those rows', async () => {
			await resetTable();
			await db.insert(pgUsers).values({id: 33, name: 'taken'});
			const failure = await insertInChunks(db, pgUsers, people(0, 50), {maxParams: 20, atomic: false}).catch((error: unknown) => error);
			assert.ok(failure instanceof ChunkedInsertError);
			assert.deepEqual([failure.insertedRows, failure.failedChunk], [30, 3]);
			assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 31}]);
		});

		test('inside a caller transaction it runs in that transaction', async () => {
			await resetTable();
			await assert.rejects(db.transaction(async tx => {
				await insertInChunks(tx, pgUsers, people(0, 30), {maxParams: 20});
				tx.rollback();
			}), /Rollback/);
			assert.deepEqual(await db.select({total: count()}).from(pgUsers), [{total: 0}]);
		});
	});
}

describe('mysql2', {skip: process.env.MYSQL_URL ? false : 'set MYSQL_URL to run'}, () => {
	let pool: mysql.Pool;
	let db: MySql2Database;
	const resetTable = async () => {
		await db.execute(sql`drop table if exists chunked_users`);
		await db.execute(sql`create table chunked_users (id int primary key, name text not null)`);
	};

	before(() => {
		pool = mysql.createPool({uri: process.env.MYSQL_URL!, connectionLimit: 1});
		db = mysql2Drizzle({client: pool});
	});
	after(() => pool.end());

	test('70,000 rows go in as chunks of 32,767', async () => {
		await resetTable();
		const rows = people(0, 70_000);
		assert.deepEqual(planChunks(db, mysqlUsers, rows).map(chunk => chunk.length), [32_767, 32_767, 4466]);
		await insertInChunks(db, mysqlUsers, rows);
		assert.deepEqual(await db.select({total: count()}).from(mysqlUsers), [{total: 70_000}]);
	});

	test('a failing chunk rolls back the chunks before it', async () => {
		await resetTable();
		await assert.rejects(insertInChunks(db, mysqlUsers, withDuplicateAtEnd(50), {maxParams: 20}), failsWith(/Duplicate entry/));
		assert.deepEqual(await db.select({total: count()}).from(mysqlUsers), [{total: 0}]);
	});

	test('with atomic false, a failure says how far it got and keeps those rows', async () => {
		await resetTable();
		await db.insert(mysqlUsers).values({id: 33, name: 'taken'});
		const failure = await insertInChunks(db, mysqlUsers, people(0, 50), {maxParams: 20, atomic: false}).catch((error: unknown) => error);
		assert.ok(failure instanceof ChunkedInsertError);
		assert.deepEqual([failure.insertedRows, failure.failedChunk], [30, 3]);
		assert.deepEqual(await db.select({total: count()}).from(mysqlUsers), [{total: 31}]);
	});

	test('inside a caller transaction it runs in that transaction', async () => {
		await resetTable();
		await assert.rejects(db.transaction(async tx => {
			await insertInChunks(tx, mysqlUsers, people(0, 30), {maxParams: 20});
			tx.rollback();
		}), /Rollback/);
		assert.deepEqual(await db.select({total: count()}).from(mysqlUsers), [{total: 0}]);
	});
});

// drizzle's node:sqlite driver exists from 1.0, so this runs in CI's drizzle-orm 1.0 job.
const nodeSqliteModule = 'drizzle-orm/node-sqlite';
// Typed as better-sqlite3's database, whose query API it shares, since 0.x has no types for it.
const nodeSqlite = await import(nodeSqliteModule).catch(() => undefined) as {drizzle: (config: {client: DatabaseSync}) => BetterSQLite3Database & {$client: DatabaseSync}} | undefined;

describe('node:sqlite', {skip: nodeSqlite ? false : 'needs drizzle-orm 1.0'}, () => {
	test('40,000 rows go in as chunks of 16,383 and roll back together', async () => {
		const db = nodeSqlite!.drizzle({client: new DatabaseSync(':memory:')});
		after(() => db.$client.close());
		await db.run(sql`create table users (id integer primary key, name text not null)`);
		assert.deepEqual(planChunks(db, sqliteUsers, people(0, 40_000)).map(chunk => chunk.length), [16_383, 16_383, 7234]);
		await assert.rejects(insertInChunks(db, sqliteUsers, withDuplicateAtEnd(40_000)), failsWith(/UNIQUE constraint failed/));
		assert.deepEqual(await db.select({total: count()}).from(sqliteUsers), [{total: 0}]);
		await insertInChunks(db, sqliteUsers, people(0, 40_000));
		assert.deepEqual(await db.select({total: count()}).from(sqliteUsers), [{total: 40_000}]);
	});
});
