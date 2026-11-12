import assert from 'node:assert/strict';
import {test} from 'node:test';
import {type ChunkLimits, type ChunkRange, fits, initialChunkRows, planRanges, RowTooLargeError, sampleCosts, shrinkRows} from '../src/plan.ts';

// A small seeded generator, so a failing shape can be replayed from its seed.
function randomGenerator(seed: number) {
	let state = seed >>> 0;
	return (below: number) => {
		// mulberry32
		state = (state + 0x6D_2B_79_F5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) % below;
	};
}

interface Shape {
	readonly rowParams: number[];
	readonly rowBytes: number[];
	readonly statementParams: number;
	readonly statementBytes: number;
}

// Sums per-row costs plus a fixed per-statement cost, like an insert with an upsert `set` clause.
function measureShape(shape: Shape, calls: Array<[number, number]> = []) {
	return (start: number, end: number) => {
		calls.push([start, end]);
		const sum = (values: number[]) => values.slice(start, end).reduce((total, value) => total + value, 0);
		return {params: shape.statementParams + sum(shape.rowParams), sqlLength: shape.statementBytes + sum(shape.rowBytes)};
	};
}

function assertCovers(ranges: ChunkRange[], rowCount: number) {
	assert.deepEqual(ranges.map(range => range.start), [0, ...ranges.slice(0, -1).map(range => range.end)]);
	assert.equal(ranges.at(-1)?.end ?? 0, rowCount);
	assert.ok(ranges.every(range => range.end > range.start));
}

test('zero rows plan no chunks and measure nothing', () => {
	const calls: Array<[number, number]> = [];
	assert.deepEqual(planRanges(0, 10, measureShape({rowParams: [], rowBytes: [], statementParams: 0, statementBytes: 0}, calls), {maxParams: 100}), []);
	assert.deepEqual(calls, []);
});

test('rows that match the estimate fill each chunk to the limit in one measurement', () => {
	const shape = {rowParams: Array(250).fill(3), rowBytes: Array(250).fill(9), statementParams: 0, statementBytes: 40};
	const limits = {maxParams: 100};
	const calls: Array<[number, number]> = [];
	const ranges = planRanges(250, initialChunkRows(3, limits), measureShape(shape, calls), limits);
	assert.deepEqual(ranges.map(range => range.end - range.start), [33, 33, 33, 33, 33, 33, 33, 19]);
	assert.equal(calls.length, ranges.length);
});

test('a per-statement cost takes a few rows off each chunk, not half of it', () => {
	const shape = {rowParams: Array(1000).fill(2), rowBytes: Array(1000).fill(8), statementParams: 6, statementBytes: 60};
	const limits = {maxParams: 100};
	const ranges = planRanges(1000, initialChunkRows(2, limits), measureShape(shape), limits);
	assert.deepEqual(new Set(ranges.slice(0, -1).map(range => range.end - range.start)), new Set([47]));
});

test('the SQL length limit shrinks chunks the parameter estimate let through', () => {
	const shape = {rowParams: Array(40).fill(1), rowBytes: Array(40).fill(1000), statementParams: 0, statementBytes: 30};
	const limits = {maxParams: 100, maxSqlLength: 10_000};
	const ranges = planRanges(40, initialChunkRows(1, limits), measureShape(shape), limits);
	assert.deepEqual(ranges.map(range => range.end - range.start), [9, 9, 9, 9, 4]);
});

test('maxRows caps the chunk size below what the limits allow', () => {
	assert.equal(initialChunkRows(2, {maxParams: 32_766, maxRows: 500}), 500);
	assert.equal(initialChunkRows(2, {maxParams: 32_766}), 16_383);
	assert.equal(initialChunkRows(0, {maxParams: 100}), 100);
	assert.equal(initialChunkRows(500, {maxParams: 100}), 1);
	assert.equal(initialChunkRows(2, {maxParams: 20}, 1), 9);
});

test('sample costs split into per-row and per-statement parameters', () => {
	assert.deepEqual(sampleCosts({params: 3, sqlLength: 0}, {params: 5, sqlLength: 0}), {rowParams: 2, statementParams: 1});
	assert.deepEqual(sampleCosts({params: 3, sqlLength: 0}, undefined), {rowParams: 3, statementParams: 0});
});

test('a row too large on its own fails with its index and size before anything else is planned', () => {
	const shape = {rowParams: [1, 1, 150, 1], rowBytes: [5, 5, 5, 5], statementParams: 0, statementBytes: 20};
	const limits = {maxParams: 100};
	assert.throws(() => planRanges(4, 4, measureShape(shape), limits), (error: unknown) => {
		assert.ok(error instanceof RowTooLargeError);
		assert.equal(error.rowIndex, 2);
		assert.deepEqual(error.size, {params: 150, sqlLength: 25});
		assert.equal(error.message, 'Row 2 needs 150 bound parameters and 25 bytes of SQL, which is over the limit of 100 parameters even on its own.');
		return true;
	});
	assert.throws(() => planRanges(1, 1, () => ({params: 1, sqlLength: 500}), {maxParams: 100, maxSqlLength: 200}), /over the limit of 100 parameters or 200 bytes/);
});

test('shrinking always drops at least one row and keeps at least one', () => {
	assert.equal(shrinkRows(10, {params: 101, sqlLength: 0}, {maxParams: 100}), 9);
	assert.equal(shrinkRows(10, {params: 1000, sqlLength: 0}, {maxParams: 100}), 1);
	assert.equal(shrinkRows(10, {params: 1_000_000, sqlLength: 0}, {maxParams: 100}), 1);
	assert.equal(shrinkRows(10, {params: 50, sqlLength: 400}, {maxParams: 100, maxSqlLength: 100}), 2);
});

test('fits checks both limits', () => {
	assert.equal(fits({params: 100, sqlLength: 10_000}, {maxParams: 100, maxSqlLength: 10_000}), true);
	assert.equal(fits({params: 101, sqlLength: 1}, {maxParams: 100}), false);
	assert.equal(fits({params: 1, sqlLength: 10_001}, {maxParams: 100, maxSqlLength: 10_000}), false);
	assert.equal(fits({params: 1, sqlLength: Number.MAX_SAFE_INTEGER}, {maxParams: 100}), true);
});

test('random row shapes never produce a chunk over the limits and keep every row in order', () => {
	for (let seed = 1; seed <= 300; seed++) {
		const random = randomGenerator(seed);
		const rowCount = random(400);
		const limits: ChunkLimits = {
			maxParams: 30 + random(200),
			...(random(2) === 0 ? {} : {maxSqlLength: 500 + random(5000)}),
			...(random(3) === 0 ? {maxRows: 1 + random(50)} : {}),
		};
		const shape = {
			rowParams: Array.from({length: rowCount}, () => random(10) === 0 ? random(15) : random(6)),
			rowBytes: Array.from({length: rowCount}, () => 5 + random(60)),
			statementParams: random(8),
			statementBytes: 20 + random(80),
		};
		const measure = measureShape(shape);
		const ranges = planRanges(rowCount, initialChunkRows(1 + random(6), limits), measure, limits);
		assertCovers(ranges, rowCount);
		for (const range of ranges) {
			assert.ok(fits(measure(range.start, range.end), limits), `seed ${seed}: chunk ${range.start}-${range.end} is over the limits`);
			assert.ok(range.end - range.start <= (limits.maxRows ?? rowCount), `seed ${seed}: chunk ${range.start}-${range.end} has more than maxRows rows`);
		}
	}
});
