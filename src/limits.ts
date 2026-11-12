import type {ChunkLimits} from './plan.ts';

/**
 * How the chunks run atomically on a driver:
 * - `batch`: one `db.batch()` call, which the driver runs as a single transaction;
 * - `sync-transaction`: `db.transaction()` with a synchronous callback;
 * - `transaction`: `db.transaction()` with an async callback.
 */
export type AtomicStrategy = 'batch' | 'sync-transaction' | 'transaction';

export interface DriverProfile {
	readonly limits: ChunkLimits;
	readonly strategy: AtomicStrategy;
}

/** Facts about a drizzle database or transaction, read from its class chain and fields. */
export interface DriverTraits {
	/** The `entityKind` names of the session's class chain, most derived first. */
	readonly sessionKinds: readonly string[];
	/** The `entityKind` names of the database's own class chain, most derived first. */
	readonly databaseKinds: readonly string[];
	/** True for SQLite drivers whose queries run synchronously. */
	readonly synchronous: boolean;
}

export const cloudflareLimits: ChunkLimits = {maxParams: 100, maxSqlLength: 100_000};
export const sqliteLimits: ChunkLimits = {maxParams: 32_766};
export const postgresLimits: ChunkLimits = {maxParams: 65_535};
export const mysqlLimits: ChunkLimits = {maxParams: 65_535};
/** SQLite's limit before 3.32, for SQLite drivers whose bundled version isn't known. */
export const conservativeLimits: ChunkLimits = {maxParams: 999};

// Measured in test/limits.db.test.ts. D1 and Durable Object storage share Cloudflare's limits.
const cloudflareSessions = new Set(['SQLiteD1Session', 'SQLiteDOSession']);
const measuredSqliteSessions = new Set(['BetterSQLiteSession', 'LibSQLSession']);
// node:sqlite's driver reuses the SQLJsSession class, so it is told apart by its database.
const measuredSqliteDatabases = new Set(['NodeSQLiteDatabase', 'NodeSQLiteTransaction']);
const batchSessions = new Set(['SQLiteD1Session', 'LibSQLSession', 'NeonHttpSession']);

function includesAny(kinds: readonly string[], names: ReadonlySet<string>): boolean {
	return kinds.some(kind => names.has(kind));
}

function dialectLimits(sessionKinds: readonly string[]): ChunkLimits {
	if (sessionKinds.includes('PgSession')) {
		return postgresLimits;
	}

	if (sessionKinds.includes('MySqlSession')) {
		return mysqlLimits;
	}

	return conservativeLimits;
}

export function driverLimits(traits: DriverTraits): ChunkLimits {
	if (includesAny(traits.sessionKinds, cloudflareSessions)) {
		return cloudflareLimits;
	}

	if (includesAny(traits.databaseKinds, measuredSqliteDatabases)) {
		return sqliteLimits;
	}

	if (includesAny(traits.sessionKinds, measuredSqliteSessions)) {
		return sqliteLimits;
	}

	return dialectLimits(traits.sessionKinds);
}

export function atomicStrategy(traits: DriverTraits): AtomicStrategy {
	if (includesAny(traits.sessionKinds, batchSessions)) {
		return 'batch';
	}

	return traits.synchronous ? 'sync-transaction' : 'transaction';
}

export function driverProfile(traits: DriverTraits, overrides: Partial<ChunkLimits> = {}): DriverProfile {
	return {limits: {...driverLimits(traits), ...overrides}, strategy: atomicStrategy(traits)};
}

/**
 * How `insertInChunks` runs the chunks:
 * - `batch` and `transaction` follow the driver's atomic strategy;
 * - `sequential` runs them one by one: inside the caller's transaction, for a single chunk
 *   (one statement is atomic already), or with `atomic: false`, where a failure is `resumable`.
 */
export interface RunMode {
	readonly kind: 'batch' | 'transaction' | 'sequential';
	readonly synchronous: boolean;
	readonly resumable: boolean;
}

export interface RunContext {
	readonly strategy: AtomicStrategy;
	readonly synchronous: boolean;
	readonly atomic: boolean;
	readonly inTransaction: boolean;
	readonly chunkCount: number;
}

export function chooseRunMode(context: RunContext): RunMode {
	const sequential = {kind: 'sequential', synchronous: context.synchronous} as const;
	if (!context.atomic) {
		return {...sequential, resumable: true};
	}

	if (context.inTransaction || context.chunkCount === 1) {
		return {...sequential, resumable: false};
	}

	return context.strategy === 'batch'
		? {kind: 'batch', synchronous: false, resumable: false}
		: {kind: 'transaction', synchronous: context.strategy === 'sync-transaction', resumable: false};
}
