import type {Table} from 'drizzle-orm';
import {chooseRunMode, driverProfile} from './limits.ts';
import {rowParamBounds} from './estimate.ts';
import {type ChunkLimits, type ChunkRange, initialChunkRows, type MeasureChunk, planByParamBounds, planRanges, sampleCosts, validateLimits} from './plan.ts';
import {type BuildChunk, type ChunkQuery, hasReturning, isTransaction, measureChunks, readTraits, runChunks} from './run.ts';

export {ChunkedInsertError, type BuildChunk, type ChunkQuery} from './run.ts';
export {RowTooLargeError, type ChunkLimits} from './plan.ts';

export interface ChunkOptions {
	/** Most bound parameters per statement. Defaults to the detected driver's limit. */
	readonly maxParams?: number;
	/** Longest statement in bytes. Defaults to the detected driver's limit, if it has one. */
	readonly maxSqlLength?: number;
	/** Most rows per chunk, below what the limits allow. */
	readonly maxRows?: number;
}

export interface InsertOptions extends ChunkOptions {
	/**
	 * Insert every row or none (the default). With `false` each chunk commits on its own, and a
	 * failure throws `ChunkedInsertError` saying how many rows went in.
	 */
	readonly atomic?: boolean;
}

/** What `insertInChunks` resolves to: every chunk's `returning()` rows in input order, or nothing. */
export type InsertedRows<TQuery> = TQuery extends {readonly _: {readonly returning: infer TReturning}}
	? TReturning extends undefined ? void : TReturning[]
	: void;

interface InsertableInto<TTable extends Table> {
	insert(table: TTable): {values(values: Array<TTable['$inferInsert']>): ChunkQuery};
}

function insertBuilder<TTable extends Table>(table: TTable): BuildChunk<InsertableInto<TTable>, TTable['$inferInsert'], ChunkQuery> {
	return (db, rows) => db.insert(table).values(rows);
}

function limitOverrides(options: ChunkOptions): Partial<ChunkLimits> {
	return Object.fromEntries(Object.entries({maxParams: options.maxParams, maxSqlLength: options.maxSqlLength, maxRows: options.maxRows})
		.filter(([, value]) => value !== undefined));
}

interface Plan<TRow> {
	readonly chunks: TRow[][];
	readonly ranges: ReturnType<typeof planRanges>;
	readonly returning: boolean;
}

// Rows compiled to check that a counted plan's bounds hold before trusting them for the rest.
const boundCheckRows = 100;

/**
 * Plans a plain `insert(table).values(rows)` by counting parameters instead of compiling every chunk,
 * which would cost as much as running the insert. Only where length isn't limited (every driver but
 * Cloudflare's), and only if compiling the first rows confirms the count; `undefined` otherwise.
 */
function countedRanges(table: Table | undefined, rows: readonly unknown[], measure: MeasureChunk, limits: ChunkLimits): ChunkRange[] | undefined {
	if (table === undefined || limits.maxSqlLength !== undefined) {
		return undefined;
	}

	const bounds = rowParamBounds(table, rows as ReadonlyArray<Record<string, unknown>>);
	const ranges = bounds && planByParamBounds(bounds, limits);
	const checkedRows = Math.min(rows.length, boundCheckRows);
	const checkedBound = bounds?.slice(0, checkedRows).reduce((sum, bound) => sum + bound, 0) ?? 0;
	return ranges && measure(0, checkedRows).params <= checkedBound ? ranges : undefined;
}

function plan<TDb, TRow, TQuery extends ChunkQuery>(db: TDb, {rows, build, table}: Normalized<TRow, TQuery>, options: ChunkOptions): Plan<TRow> {
	const {limits} = driverProfile(readTraits(db), validateLimits(limitOverrides(options)));
	if (rows.length === 0) {
		return {chunks: [], ranges: [], returning: false};
	}

	const measure = measureChunks(db, rows, build);
	const ranges = countedRanges(table, rows, measure, limits) ?? measuredRanges(rows.length, measure, limits);
	return {chunks: ranges.map(range => rows.slice(range.start, range.end)), ranges, returning: table === undefined && hasReturning(build(db, rows.slice(0, 1)))};
}

function measuredRanges(rowCount: number, measure: MeasureChunk, limits: ChunkLimits): ChunkRange[] {
	const {rowParams, statementParams} = sampleCosts(measure(0, 1), rowCount > 1 ? measure(0, 2) : undefined);
	return planRanges(rowCount, initialChunkRows(rowParams, limits, statementParams), measure, limits);
}

interface Normalized<TRow, TQuery extends ChunkQuery> {
	readonly rows: readonly TRow[];
	readonly build: BuildChunk<unknown, TRow, TQuery>;
	/** The table, for the `(db, table, rows)` form. */
	readonly table?: Table;
}

// Both call forms, `(db, table, rows)` and `(db, rows, build)`, as rows plus a chunk builder.
function normalize(first: unknown, second: unknown): Normalized<unknown, ChunkQuery> {
	return Array.isArray(first)
		? {rows: first, build: second as BuildChunk<unknown, unknown, ChunkQuery>}
		: {rows: second as readonly unknown[], build: insertBuilder(first as Table) as BuildChunk<unknown, unknown, ChunkQuery>, table: first as Table};
}

/**
 * Splits `rows` into the chunks `insertInChunks` would run, without running anything. Each chunk
 * fits the driver's bound-parameter and statement-length limits once compiled.
 */
export function planChunks<TDb extends InsertableInto<TTable>, TTable extends Table>(db: TDb, table: TTable, rows: ReadonlyArray<TTable['$inferInsert']>, options?: ChunkOptions): Array<Array<TTable['$inferInsert']>>;
export function planChunks<TDb, TRow, TQuery extends ChunkQuery>(db: TDb, rows: readonly TRow[], build: BuildChunk<TDb, TRow, TQuery>, options?: ChunkOptions): TRow[][];
export function planChunks(db: unknown, first: unknown, second: unknown, options: ChunkOptions = {}): unknown[][] {
	return plan(db, normalize(first, second), options).chunks;
}

/**
 * Inserts `rows` in as few statements as the driver's limits allow, atomically by default.
 *
 * `insertInChunks(db, users, rows)` inserts plain rows. For upserts or `returning()`, build each
 * chunk's query on the `db` you are handed, which is the transaction when the insert is atomic:
 * `insertInChunks(db, rows, (db, chunk) => db.insert(users).values(chunk).returning())`.
 */
export function insertInChunks<TDb extends InsertableInto<TTable>, TTable extends Table>(db: TDb, table: TTable, rows: ReadonlyArray<TTable['$inferInsert']>, options?: InsertOptions): Promise<void>;
export function insertInChunks<TDb, TRow, TQuery extends ChunkQuery>(db: TDb, rows: readonly TRow[], build: BuildChunk<TDb, TRow, TQuery>, options?: InsertOptions): Promise<InsertedRows<TQuery>>;
export async function insertInChunks(db: unknown, first: unknown, second: unknown, options: InsertOptions = {}): Promise<unknown> {
	const normalized = normalize(first, second);
	const {rows, build} = normalized;
	const {ranges, returning} = plan(db, normalized, options);
	// Without a row there is no query to tell whether `returning()` was used, and [] suits both.
	if (ranges.length === 0) {
		return [];
	}

	const traits = readTraits(db);
	const mode = chooseRunMode({
		strategy: driverProfile(traits).strategy,
		synchronous: traits.synchronous,
		atomic: options.atomic ?? true,
		inTransaction: isTransaction(db),
		chunkCount: ranges.length,
	});
	const results = await runChunks({db, rows, ranges, build}, mode);
	return returning ? results.flat() : undefined;
}
