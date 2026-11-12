import assert from 'node:assert/strict';
import {test} from 'node:test';

test('the entry module loads', async () => {
	const entry = await import('../src/index.ts');
	assert.equal(typeof entry, 'object');
});
