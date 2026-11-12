export interface ChunkLimits {
	/** Most bound parameters one statement may carry. */
	readonly maxParams: number;
	/** Longest statement, in bytes, the driver accepts. */
	readonly maxSqlLength?: number;
	/** Most rows per chunk, for callers who want smaller statements. */
	readonly maxRows?: number;
}

/** What one compiled chunk costs: its bound parameters and its SQL length in bytes. */
export interface ChunkSize {
	readonly params: number;
	readonly sqlLength: number;
}

/** A chunk as the half-open row range `[start, end)` of the input. */
export interface ChunkRange {
	readonly start: number;
	readonly end: number;
}

/** Compiles rows `[start, end)` as one statement and reports its size. */
export type MeasureChunk = (start: number, end: number) => ChunkSize;

export class RowTooLargeError extends Error {
	override readonly name = 'RowTooLargeError';
	readonly rowIndex: number;
	readonly size: ChunkSize;
	readonly limits: ChunkLimits;

	constructor(rowIndex: number, size: ChunkSize, limits: ChunkLimits) {
		super(`Row ${rowIndex} needs ${describeSize(size)}, which is over the limit of ${describeLimits(limits)} even on its own.`);
		this.rowIndex = rowIndex;
		this.size = size;
		this.limits = limits;
	}
}

function describeSize(size: ChunkSize): string {
	return `${size.params} bound parameters and ${size.sqlLength} bytes of SQL`;
}

function describeLimits(limits: ChunkLimits): string {
	return limits.maxSqlLength === undefined
		? `${limits.maxParams} parameters`
		: `${limits.maxParams} parameters or ${limits.maxSqlLength} bytes`;
}

/** Throws a `RangeError` unless every limit is a positive whole number, so a typo can't turn into odd chunks. */
export function validateLimits<TLimits extends Partial<ChunkLimits>>(limits: TLimits): TLimits {
	for (const [name, value] of Object.entries(limits)) {
		if (!(Number.isSafeInteger(value) && value > 0)) {
			throw new RangeError(`${name} must be a positive whole number, got ${value}.`);
		}
	}

	return limits;
}

export function fits(size: ChunkSize, limits: ChunkLimits): boolean {
	return size.params <= limits.maxParams && (limits.maxSqlLength === undefined || size.sqlLength <= limits.maxSqlLength);
}

/**
 * The first guess at rows per chunk, from what one row costs and what every statement costs on top
 * (an upsert's `set` clause, say). Every chunk is checked against its compiled size anyway.
 */
export function initialChunkRows(rowParams: number, limits: ChunkLimits, statementParams = 0): number {
	const byParams = Math.floor((limits.maxParams - statementParams) / Math.max(rowParams, 1));
	return Math.max(1, Math.min(byParams, limits.maxRows ?? Number.POSITIVE_INFINITY));
}

/** Splits the measured sizes of a one-row and a two-row chunk into per-row and per-statement parameters. */
export function sampleCosts(oneRow: ChunkSize, twoRows: ChunkSize | undefined): {rowParams: number; statementParams: number} {
	const rowParams = twoRows === undefined ? oneRow.params : twoRows.params - oneRow.params;
	// Rows of different shapes can make the second row cost more than the first; never below zero.
	return {rowParams, statementParams: Math.max(0, oneRow.params - rowParams)};
}

/**
 * How many rows to try after `rows` rows compiled to `size` and overflowed. Shrinks in proportion
 * to the overflow, so a fixed per-statement cost (an upsert's `set` clause) costs a few rows
 * instead of half the chunk, and always takes at least one row off.
 */
export function shrinkRows(rows: number, size: ChunkSize, limits: ChunkLimits): number {
	const byParams = size.params > limits.maxParams ? Math.floor(rows * limits.maxParams / size.params) : rows;
	const byLength = limits.maxSqlLength !== undefined && size.sqlLength > limits.maxSqlLength
		? Math.floor(rows * limits.maxSqlLength / size.sqlLength)
		: rows;
	return Math.max(1, Math.min(byParams, byLength, rows - 1));
}

/**
 * Splits `rowCount` rows into consecutive chunks that each fit `limits` once compiled. Chunks start
 * at `initialRows` rows; a chunk that overflows is shrunk and measured again, and the smaller size
 * carries on to the next chunks so similar rows aren't measured twice. A row that overflows on its
 * own throws `RowTooLargeError` before any statement runs.
 */
export function planRanges(rowCount: number, initialRows: number, measure: MeasureChunk, limits: ChunkLimits): ChunkRange[] {
	const ranges: ChunkRange[] = [];
	let rows = Math.max(1, initialRows);
	let start = 0;
	while (start < rowCount) {
		const end = Math.min(start + rows, rowCount);
		const size = measure(start, end);
		if (fits(size, limits)) {
			ranges.push({start, end});
			start = end;
		} else if (end - start === 1) {
			throw new RowTooLargeError(start, size, limits);
		} else {
			rows = shrinkRows(end - start, size, limits);
		}
	}

	return ranges;
}
