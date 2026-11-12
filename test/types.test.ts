import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import {drizzle as betterSqliteDrizzle} from 'drizzle-orm/better-sqlite3';
import {integer as pgInteger, pgTable, text as pgText} from 'drizzle-orm/pg-core';
import {drizzle as pgliteDrizzle} from 'drizzle-orm/pglite';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {insertInChunks, planChunks} from '../src/index.ts';

// Checked by `npm run typecheck`; the bodies never run.
const users = sqliteTable('users', {id: integer('id').primaryKey(), name: text('name').notNull()});
const pgUsers = pgTable('users', {id: pgInteger('id').primaryKey(), name: pgText('name')});

export async function typeChecks() {
	const db = betterSqliteDrizzle({client: new Database(':memory:')});
	const pg = pgliteDrizzle({client: new PGlite()});

	const plain: void = await insertInChunks(db, users, [{id: 1, name: 'a'}]);
	// @ts-expect-error name is required
	await insertInChunks(db, users, [{id: 1}]);

	const ids: Array<{id: number}> = await insertInChunks(db, [{id: 1, name: 'a'}], (tx, chunk) => tx.insert(users).values(chunk).returning({id: users.id}));
	const everything: Array<{id: number; name: string | null}> = await insertInChunks(pg, [{id: 1, name: 'a'}], (tx, chunk) => tx.insert(pgUsers).values(chunk).onConflictDoNothing().returning());
	const nothing: void = await insertInChunks(pg, [{id: 1, name: 'a'}], (tx, chunk) => tx.insert(pgUsers).values(chunk).onConflictDoNothing());
	// @ts-expect-error returning() rows have no email
	const wrong: Array<{email: string}> = await insertInChunks(pg, [{id: 1}], (tx, chunk) => tx.insert(pgUsers).values(chunk).returning());

	const chunks: Array<Array<{id?: number | undefined; name: string}>> = planChunks(db, users, [{id: 1, name: 'a'}]);
	return [plain, ids, everything, nothing, wrong, chunks];
}

test('the type checks compile', () => {
	assert.equal(typeof typeChecks, 'function');
});
