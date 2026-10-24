import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
const [raw, endpoint] = process.argv.slice(2);
const original = Module._load;
let calls = 0, entered = false;
Module._load = function(name, ...args) {
  if (name === 'koffi') { calls++; throw new Error('synthetic-private C:/fixture-private/credentials'); }
  return original.call(this, name, ...args);
};
let storage;
try {
  await import('../../lib/plugins/aify-dashboard/index.mjs');
  const { ActivityState } = await import('../../lib/plugins/aify-dashboard/activity-state.mjs');
  storage = new ActivityState({ directory: raw, endpoint });
  assert.equal(calls, 0, 'imports and constructors do not load optional native dependencies');
  assert.throws(() => storage.transaction(state => {
    entered = true;
    for (const source of Object.values(state.sources)) source.generation++;
    storage.save(state);
  }), { message: 'state-lock-unavailable' }, 'missing native dependency refuses with a path-free error');
  assert.equal(entered, false, 'unavailable native lock cannot authorize checkpoint work');
  assert.equal(calls, 1, 'transaction actually attempted the native load');
} finally { Module._load = original; }
assert.equal(storage.transaction(() => 'healthy'), 'healthy', 'restored dependency admits the same owner');
assert.equal(fs.existsSync(raw), true);
console.log(JSON.stringify({ version: process.version, executable: process.execPath, calls, entered }));
