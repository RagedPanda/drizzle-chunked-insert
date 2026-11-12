import type {Table} from 'drizzle-orm';
import {classKinds} from './run.ts';

// The fields read below exist on every drizzle version from 0.36 to 1.0.
interface ColumnHandle {
	readonly default?: unknown;
	readonly defaultFn?: unknown;
	readonly onUpdateFn?: unknown;
}

const columnsSymbol = Symbol.for('drizzle:Columns');

function tableColumns(table: Table): Array<[string, ColumnHandle]> {
	return Object.entries((table as unknown as Record<symbol, Record<string, ColumnHandle>>)[columnsSymbol]!);
}

/** A drizzle object such as `sql`, a placeholder or a column, which can compile to any number of parameters. */
function isDrizzleEntity(value: unknown): boolean {
	return typeof value === 'object' && value !== null && classKinds(value).length > 0;
}

// Custom types map values with their own `toDriver`, which may return `sql` with several parameters.
const isCustomColumn = (column: ColumnHandle) => classKinds(column).some(kind => kind.endsWith('CustomColumn'));

/** Parameters one missing value can add: a default or generated value binds at most one, `null` or `default` none. */
function missingValueBound(column: ColumnHandle): number {
	const fillsIn = column.defaultFn !== undefined || column.onUpdateFn !== undefined || (column.default !== undefined && column.default !== null);
	return fillsIn ? 1 : 0;
}

/**
 * The most bound parameters each row adds to a plain `insert(table).values(rows)`, counted without
 * compiling: one per column with a plain value. `undefined` when a row holds a value only compiling
 * can count, such as `sql`, or the table has a custom column type.
 */
export function rowParamBounds(table: Table, rows: ReadonlyArray<Record<string, unknown>>): number[] | undefined {
	const columns = tableColumns(table);
	if (columns.some(([, column]) => isCustomColumn(column))) {
		return undefined;
	}

	const missingBounds = columns.map(([, column]) => missingValueBound(column));
	const bounds: number[] = [];
	for (const row of rows) {
		let bound = 0;
		for (const [index, [key]] of columns.entries()) {
			const value = row[key];
			if (isDrizzleEntity(value)) {
				return undefined;
			}

			bound += value === undefined ? missingBounds[index]! : 1;
		}

		bounds.push(bound);
	}

	return bounds;
}
