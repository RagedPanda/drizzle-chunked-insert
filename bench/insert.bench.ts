// Times inserting the same rows four ways on each in-process driver: drizzle's single `values()`,
// one statement per row, lodash-style fixed 1,000-row chunks in a transaction, and insertInChunks.
// Run with `npm run bench`; `RUNS` and `ROWS` override the defaults below.
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {PGlite} from '@electric-sql/pglite';
import {createClient} from '@libsql/client';
import Database from 'better-sqlite3';
import {sql} from 'drizzle-orm';
import {drizzle as betterSqliteDrizzle} from 'drizzle-orm/better-sqlite3';
import {drizzle as d1Drizzle} from 'drizzle-orm/d1';
import {drizzle as libsqlDrizzle} from 'drizzle-orm/libsql';
import {integer as pgInteger, pgTable, text as pgText} from 'drizzle-orm/pg-core';
import {drizzle as pgliteDrizzle} from 'drizzle-orm/pglite';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {Miniflare} from 'miniflare';
import {insertInChunks} from '../src/index.ts';

const runs = Number(process.env.RUNS ?? 10);
const rowCount = Number(process.env.ROWS ?? 100_000);
// Miniflare's D1 runs every statement through workerd, so it gets fewer rows to stay quick.
const d1RowCount = Math.min(rowCount, 10_000);
const fixedChunkRows = 1000;

const sqliteEvents = sqliteTable('events', {id: integer('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), score: integer('score').notNull()});
const pgEvents = pgTable('events', {id: pgInteger('id').primaryKey(), name: pgText('name').notNull(), email: pgText('email').notNull(), score: pgInteger('score').notNull()});
const createEvents = sql`create table events (id integer primary key, name text not null, email text not null, score integer not null)`;
type Row = typeof sqliteEvents.$inferInsert;

const makeRows = (total: number): Row[] => Array.from({length: total}, (_, id) => ({id, name: `user ${id}`, email: `user${id}@example.com`, score: id % 100}));

const chunk = <T>(items: readonly T[], size: number): T[][] =>
	Array.from({length: Math.ceil(items.length / size)}, (_, index) => items.slice(index * size, (index + 1) * size));

// Every driver in the benchmark has `insert(table).values(rows)` and an async `transaction`.
interface BenchDb {
	insert(table: never): {values(rows: Row[]): PromiseLike<unknown>};
	transaction<T>(run: (tx: BenchDb) => Promise<T>): Promise<T>;
}

interface Driver {
	readonly name: string;
	readonly rows: number;
	/** Approaches left out for this driver, with the reason printed in their cell. */
	readonly skip?: Readonly<Record<string, string>>;
	open(): Promise<{db: BenchDb; table: never; close: () => Promise<void>}>;
}

const drivers: Driver[] = [
	{name: 'better-sqlite3', rows: rowCount, async open() {
		const db = betterSqliteDrizzle({client: new Database(':memory:')});
		db.run(createEvents);
		// better-sqlite3's transaction callback must be synchronous, so the async approaches use plain statements.
		const asBench = {
			insert: (table: never) => ({values: async (rows: Row[]) => db.insert(table).values(rows).run()}),
			transaction: async <T>(run: (tx: BenchDb) => Promise<T>) => {
				db.run(sql`begin`);
				try {
					const result = await run(asBench);
					db.run(sql`commit`);
					return result;
				} catch (error) {
					db.run(sql`rollback`);
					throw error;
				}
			},
		} as BenchDb;
		return {db: Object.assign(asBench, {chunked: db}), table: sqliteEvents as never, close: async () => {
			db.$client.close();
		}};
	}},
	{name: 'libsql', rows: rowCount, async open() {
		const db = libsqlDrizzle({client: createClient({url: ':memory:'})});
		await db.run(createEvents);
		return {db: db as unknown as BenchDb, table: sqliteEvents as never, close: async () => db.$client.close()};
	}},
	{name: 'PGlite', rows: rowCount, async open() {
		const db = pgliteDrizzle({client: new PGlite()});
		await db.execute(createEvents);
		return {db: db as unknown as BenchDb, table: pgEvents as never, close: () => db.$client.close()};
	}},
	// Each D1 statement is a round trip to workerd, about 10 ms, so row by row would take minutes per run.
	{name: 'D1 (Miniflare)', rows: d1RowCount, skip: {'one row per statement': 'skipped: about 10 ms per row'}, async open() {
		const miniflare = new Miniflare({modules: true, script: 'export default {}', d1Databases: ['DB']});
		const db = d1Drizzle(await miniflare.getD1Database('DB') as never);
		await db.run(createEvents);
		// D1 has no interactive transactions; its all-or-nothing tool is db.batch.
		const asBench = {
			insert: (table: never) => db.insert(table),
			transaction: async <T>(run: (tx: BenchDb) => Promise<T>) => run(asBench),
		} as unknown as BenchDb;
		return {db: Object.assign(asBench, {chunked: db, batch: db.batch.bind(db)}), table: sqliteEvents as never, close: () => miniflare.dispose()};
	}},
];

interface Approach {
	readonly name: string;
	run(db: BenchDb & {chunked?: unknown; batch?: (queries: unknown[]) => Promise<unknown>}, table: never, rows: Row[]): PromiseLike<unknown>;
}

const approaches: Approach[] = [
	{name: 'single values()', run: (db, table, rows) => db.insert(table).values(rows)},
	{name: 'one row per statement', run: (db, table, rows) => db.transaction(async tx => {
		for (const row of rows) {
			await tx.insert(table).values([row]);
		}
	})},
	{name: `fixed ${fixedChunkRows}-row chunks`, run: (db, table, rows) => db.batch
		? db.batch(chunk(rows, fixedChunkRows).map(part => db.insert(table).values(part)))
		: db.transaction(async tx => {
			for (const part of chunk(rows, fixedChunkRows)) {
				await tx.insert(table).values(part);
			}
		})},
	{name: 'insertInChunks', run: (db, table, rows) => insertInChunks((db.chunked ?? db) as never, table, rows as never)},
];

const median = (values: number[]) => {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

// The innermost cause, since drizzle 1.0 wraps driver errors in DrizzleQueryError.
function rootMessage(error: unknown): string {
	const {cause} = error as {cause?: unknown};
	return cause instanceof Error ? rootMessage(cause) : String((error as Error).message ?? error);
}

async function timeOnce(driver: Driver, approach: Approach, rows: Row[]): Promise<number> {
	const {db, table, close} = await driver.open();
	try {
		const start = performance.now();
		await approach.run(db, table, rows);
		return performance.now() - start;
	} finally {
		await close();
	}
}

async function measure(driver: Driver, approach: Approach): Promise<string> {
	const skipped = driver.skip?.[approach.name];
	if (skipped !== undefined) {
		return skipped;
	}

	const rows = makeRows(driver.rows);
	const times: number[] = [];
	try {
		// One warm-up run, not counted.
		await timeOnce(driver, approach, rows);
		for (let run = 0; run < runs; run++) {
			times.push(await timeOnce(driver, approach, rows));
		}
	} catch (error) {
		return `fails: ${rootMessage(error).split('\n')[0]!.slice(0, 60)}`;
	}

	const ms = median(times);
	return `${ms.toFixed(0)} ms (${Math.round(driver.rows / ms * 1000).toLocaleString('en-US')} rows/s)`;
}

console.log(`Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} cores, ${os.platform()} ${os.release()}`);
console.log(`Median of ${runs} runs after one warm-up, a fresh in-memory database per run, 4-column rows.\n`);
console.log(`| Driver (rows) | ${approaches.map(approach => approach.name).join(' | ')} |`);
console.log(`| --- | ${approaches.map(() => '---').join(' | ')} |`);
for (const driver of drivers) {
	const cells: string[] = [];
	for (const approach of approaches) {
		cells.push(await measure(driver, approach));
	}

	console.log(`| ${driver.name} (${driver.rows.toLocaleString('en-US')}) | ${cells.join(' | ')} |`);
}
