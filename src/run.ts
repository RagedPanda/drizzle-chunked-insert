import {entityKind} from 'drizzle-orm';
import type {DriverTraits, RunMode} from './limits.ts';
import type {ChunkRange, ChunkSize, MeasureChunk} from './plan.ts';

/** What the library needs from a built insert: the compiled SQL, and a way to run it. */
export interface ChunkQuery extends PromiseLike<unknown> {
	toSQL(): {sql: string; params: unknown[]};
}

/** Builds one chunk's insert on the database, or on the transaction the chunks run in. */
export type BuildChunk<TDb, TRow, TQuery extends ChunkQuery> = (db: TDb, rows: TRow[]) => TQuery;

// The fields and methods read below exist on every drizzle version from 0.36 to 1.0,
// though drizzle's own types mark some of them private.
interface DrizzleHandle {
	readonly session?: object;
	readonly resultKind?: string;
	rollback?: () => never;
	transaction?: (run: (tx: never) => unknown) => unknown;
	batch?: (queries: unknown[]) => Promise<unknown[]>;
}

interface SyncQuery {
	readonly config?: {returning?: unknown};
	run(): unknown;
	all(): unknown;
}

export class ChunkedInsertError extends Error {
	override readonly name = 'ChunkedInsertError';
	/** Rows inserted by the chunks before the failed one. They stay inserted. */
	readonly insertedRows: number;
	/** Index of the chunk that failed. Resume with the rows from `insertedRows` onward. */
	readonly failedChunk: number;

	constructor(cause: unknown, insertedRows: number, failedChunk: number) {
		super(`Chunk ${failedChunk} failed after ${insertedRows} rows were inserted.`, {cause});
		this.insertedRows = insertedRows;
		this.failedChunk = failedChunk;
	}
}

/** The `entityKind` names along an object's class chain, most derived first. */
export function classKinds(value: object | undefined): string[] {
	const kinds: string[] = [];
	for (let prototype = value === undefined ? null : Object.getPrototypeOf(value); prototype !== null && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
		const kind = (prototype.constructor as Record<symbol, unknown>)[entityKind];
		if (typeof kind === 'string' && kind !== kinds.at(-1)) {
			kinds.push(kind);
		}
	}

	return kinds;
}

function handle(db: unknown): DrizzleHandle {
	return db as DrizzleHandle;
}

export function readTraits(db: unknown): DriverTraits {
	return {
		sessionKinds: classKinds(handle(db).session),
		databaseKinds: classKinds(db as object),
		synchronous: handle(db).resultKind === 'sync',
	};
}

/** A transaction has `rollback()`; a database doesn't. Class names can't tell, since drizzle 1.0 renamed them. */
export function isTransaction(db: unknown): boolean {
	return typeof handle(db).rollback === 'function';
}

const encoder = new TextEncoder();

export function measureChunks<TDb, TRow, TQuery extends ChunkQuery>(db: TDb, rows: readonly TRow[], build: BuildChunk<TDb, TRow, TQuery>): MeasureChunk {
	return (start, end): ChunkSize => {
		const {sql, params} = build(db, rows.slice(start, end)).toSQL();
		return {params: params.length, sqlLength: encoder.encode(sql).length};
	};
}

export function hasReturning(query: ChunkQuery): boolean {
	return Boolean((query as Partial<SyncQuery>).config?.returning);
}

function runSync(query: ChunkQuery): unknown {
	const syncQuery = query as unknown as SyncQuery;
	return hasReturning(query) ? syncQuery.all() : syncQuery.run();
}

interface RunInput<TDb, TRow, TQuery extends ChunkQuery> {
	readonly db: TDb;
	readonly rows: readonly TRow[];
	readonly ranges: readonly ChunkRange[];
	readonly build: BuildChunk<TDb, TRow, TQuery>;
}

function chunkRows<TRow>(rows: readonly TRow[], range: ChunkRange): TRow[] {
	return rows.slice(range.start, range.end);
}

async function runSequential<TDb, TRow, TQuery extends ChunkQuery>({db, rows, ranges, build}: RunInput<TDb, TRow, TQuery>, mode: RunMode): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const [index, range] of ranges.entries()) {
		try {
			const query = build(db, chunkRows(rows, range));
			results.push(mode.synchronous ? runSync(query) : await query);
		} catch (error) {
			throw mode.resumable ? new ChunkedInsertError(error, range.start, index) : error;
		}
	}

	return results;
}

async function runInTransaction<TDb, TRow, TQuery extends ChunkQuery>({db, rows, ranges, build}: RunInput<TDb, TRow, TQuery>): Promise<unknown[]> {
	return handle(db).transaction!(async (tx: TDb) => {
		const results: unknown[] = [];
		for (const range of ranges) {
			results.push(await build(tx, chunkRows(rows, range)));
		}

		return results;
	}) as Promise<unknown[]>;
}

function runInSyncTransaction<TDb, TRow, TQuery extends ChunkQuery>({db, rows, ranges, build}: RunInput<TDb, TRow, TQuery>): unknown[] {
	return handle(db).transaction!((tx: TDb) => ranges.map(range => runSync(build(tx, chunkRows(rows, range))))) as unknown[];
}

/** Runs the planned chunks the way `mode` says and returns each chunk's result in order. */
export async function runChunks<TDb, TRow, TQuery extends ChunkQuery>(input: RunInput<TDb, TRow, TQuery>, mode: RunMode): Promise<unknown[]> {
	switch (mode.kind) {
		case 'batch': {
			return handle(input.db).batch!(input.ranges.map(range => input.build(input.db, chunkRows(input.rows, range))));
		}

		case 'transaction': {
			return mode.synchronous ? runInSyncTransaction(input) : runInTransaction(input);
		}

		case 'sequential': {
			return runSequential(input, mode);
		}
	}
}
