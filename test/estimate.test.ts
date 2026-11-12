import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {customType, integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {rowParamBounds} from '../src/estimate.ts';

const notes = sqliteTable('notes', {
	id: integer('id').primaryKey(),
	body: text('body'),
	tag: text('tag').default('none'),
	nullDefault: text('null_default').default(null as unknown as string),
	createdAt: integer('created_at').$defaultFn(() => 0),
	updatedAt: integer('updated_at').$onUpdateFn(() => 0),
});

test('each plain value binds one parameter, and a missing one binds one only if something fills it in', () => {
	assert.deepEqual(rowParamBounds(notes, [
		{id: 1, body: 'a', tag: 'b', nullDefault: 'c', createdAt: 1, updatedAt: 1},
		{id: 2},
		{},
		{id: 3, body: null, extra: 'ignored'},
	]), [6, 4, 3, 5]);
});

test('values only compiling can count, and custom column types, are left to the measured plan', () => {
	assert.equal(rowParamBounds(notes, [{id: 1}, {id: 2, body: sql`${'a'} || ${'b'}`}]), undefined);
	const point = customType<{data: string}>({dataType: () => 'text', toDriver: value => sql`upper(${value})`});
	assert.equal(rowParamBounds(sqliteTable('places', {id: integer('id').primaryKey(), at: point('at')}), [{id: 1}]), undefined);
});
