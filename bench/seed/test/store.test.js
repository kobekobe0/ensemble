import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

test('add and get', () => {
  const store = createStore();
  const b = store.add({ title: 'Dune', author: 'Frank Herbert', year: 1965 });
  assert.equal(b.id, 1);
  assert.deepEqual(store.get(1), { id: 1, title: 'Dune', author: 'Frank Herbert', year: 1965, tags: [] });
});

test('list and remove', () => {
  const store = createStore([{ title: 'A', author: 'X', year: 2000 }, { title: 'B', author: 'Y', year: 2001 }]);
  assert.equal(store.list().length, 2);
  assert.equal(store.remove(1), true);
  assert.equal(store.remove(1), false);
  assert.deepEqual(store.list().map((b) => b.title), ['B']);
});
