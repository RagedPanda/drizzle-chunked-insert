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

export function fits(size: ChunkSize, limits: ChunkLimits): boolean {
	return size.params <= limits.maxParams && (limits.maxSqlLength === undefined || size.sqlLength <= limits.maxSqlLength);
}

/**
 * The first guess at rows per chunk: one parameter per column per row. Plain values never take
 * more, and every chunk is checked against its compiled size anyway.
 */
export function initialChunkRows(columnCount: number, limits: ChunkLimits): number {
	const byParams = Math.floor(limits.maxParams / Math.max(columnCount, 1));
	return Math.max(1, Math.min(byParams, limits.maxRows ?? Number.POSITIVE_INFINITY));
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
