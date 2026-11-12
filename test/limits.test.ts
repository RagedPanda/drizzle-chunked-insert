import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chooseRunMode, cloudflareLimits, conservativeLimits, driverProfile, mysqlLimits, postgresJsLimits, postgresLimits, sqliteLimits} from '../src/limits.ts';

const traits = (sessionKinds: string[], databaseKinds: string[] = [], synchronous = false) => ({sessionKinds, databaseKinds, synchronous});

test('each driver gets its measured limits and atomic strategy', () => {
	assert.deepEqual(driverProfile(traits(['SQLiteD1Session', 'SQLiteSession'])), {limits: cloudflareLimits, strategy: 'batch'});
	assert.deepEqual(driverProfile(traits(['SQLiteDOSession', 'SQLiteSession'], [], true)), {limits: cloudflareLimits, strategy: 'sync-transaction'});
	assert.deepEqual(driverProfile(traits(['BetterSQLiteSession', 'SQLiteSession'], [], true)), {limits: sqliteLimits, strategy: 'sync-transaction'});
	assert.deepEqual(driverProfile(traits(['LibSQLSession', 'SQLiteSession'])), {limits: sqliteLimits, strategy: 'batch'});
	assert.deepEqual(driverProfile(traits(['SQLJsSession', 'SQLiteAsyncSession', 'SQLiteSession'], ['NodeSQLiteDatabase'], true)), {limits: sqliteLimits, strategy: 'sync-transaction'});
	assert.deepEqual(driverProfile(traits(['NodePgSession', 'PgSession'])), {limits: postgresLimits, strategy: 'transaction'});
	assert.deepEqual(driverProfile(traits(['PostgresJsSession', 'PgSession'])), {limits: postgresJsLimits, strategy: 'transaction'});
	assert.deepEqual(driverProfile(traits(['NeonHttpSession', 'PgSession'])), {limits: postgresLimits, strategy: 'batch'});
	assert.deepEqual(driverProfile(traits(['MySql2Session', 'MySqlSession'])), {limits: mysqlLimits, strategy: 'transaction'});
});

test('an unknown driver gets SQLite\'s old 999-parameter limit, and overrides win', () => {
	assert.deepEqual(driverProfile(traits(['ExpoSQLiteSession', 'SQLiteSession'], [], true)).limits, conservativeLimits);
	assert.deepEqual(driverProfile(traits([])).limits, conservativeLimits);
	assert.deepEqual(driverProfile(traits(['BetterSQLiteSession']), {maxParams: 10, maxRows: 3}).limits, {maxParams: 10, maxRows: 3});
});

test('the run mode follows atomic, the caller\'s transaction and the chunk count', () => {
	const context = {strategy: 'transaction', synchronous: false, atomic: true, inTransaction: false, chunkCount: 3} as const;
	assert.deepEqual(chooseRunMode(context), {kind: 'transaction', synchronous: false, resumable: false});
	assert.deepEqual(chooseRunMode({...context, strategy: 'sync-transaction', synchronous: true}), {kind: 'transaction', synchronous: true, resumable: false});
	assert.deepEqual(chooseRunMode({...context, strategy: 'batch'}), {kind: 'batch', synchronous: false, resumable: false});
	assert.deepEqual(chooseRunMode({...context, inTransaction: true}), {kind: 'sequential', synchronous: false, resumable: false});
	assert.deepEqual(chooseRunMode({...context, chunkCount: 1, synchronous: true}), {kind: 'sequential', synchronous: true, resumable: false});
	assert.deepEqual(chooseRunMode({...context, atomic: false, inTransaction: true}), {kind: 'sequential', synchronous: false, resumable: true});
});
