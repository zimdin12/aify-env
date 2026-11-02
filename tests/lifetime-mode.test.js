import test from 'node:test';
import assert from 'node:assert/strict';
import { lifetimeMode } from '../lib/lifetime-mode.mjs';
for (const [name, witness, expected] of [
  ['managed registration', { handle: 'runner-h' }, 'managed'],
  ['resident adoption', { launcher: 'resident-cli', createdAtUs: 1000 }, 'resident'],
  ['both valid witnesses', { handle: 'runner-h', launcher: 'resident-cli', createdAtUs: 1000 }, null],
  ['neither witness', { pid: 42 }, null],
  ['resident without pinned birth', { launcher: 'resident-cli' }, null],
  ['empty managed handle', { handle: '' }, null],
  ['missing witness', null, null],
]) test(name, () => assert.equal(lifetimeMode(witness), expected));
