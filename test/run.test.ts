import assert from 'node:assert/strict';
import {test} from 'node:test';
import {entityKind} from 'drizzle-orm';
import {classKinds, hasReturning, isTransaction, readTraits} from '../src/run.ts';

class Base {
	static readonly [entityKind]: string = 'Base';
}

class Derived extends Base {
	static override readonly [entityKind]: string = 'Derived';
}

// A subclass without its own kind inherits its parent's, which is listed once.
class Unnamed extends Derived {}

class Plain {}

test('classKinds lists entityKind names from the most derived class', () => {
	assert.deepEqual(classKinds(new Unnamed()), ['Derived', 'Base']);
	assert.deepEqual(classKinds(new Plain()), []);
	assert.deepEqual(classKinds(Object.create(null) as object), []);
	assert.deepEqual(classKinds(undefined), []);
});

test('traits read from an object that is not a drizzle database are empty', () => {
	assert.deepEqual(readTraits({}), {sessionKinds: [], databaseKinds: [], synchronous: false});
	assert.equal(isTransaction({}), false);
	assert.equal(isTransaction({rollback() {}}), true);
	assert.equal(hasReturning({toSQL: () => ({sql: '', params: []}), then: () => undefined} as never), false);
});
