import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lifetimeMode, residentIdentityPin } from '../lib/lifetime-mode.mjs';
const { token } = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
for (const [name, witness, expected, pin = null] of [
  ['managed registration', { handle: 'runner-h' }, 'managed'],
  ['resident adoption', { launcher: 'resident-cli', createdAtUs: 1000 }, 'resident', 1000],
  ['both valid witnesses', { handle: 'runner-h', launcher: 'resident-cli', createdAtUs: 1000 }, null, 1000],
  ['neither witness', { pid: 42 }, null],
  ['resident without pinned birth', { launcher: 'resident-cli' }, null],
  ['empty managed handle', { handle: '' }, null],
  ['missing witness', null, null],
  ['Linux resident adoption', { launcher: 'resident-cli', pid: token.pid, startToken: token }, 'resident', token],
  ['Linux resident and managed handle are ambiguous', { handle: 'runner-h', launcher: 'resident-cli', pid: token.pid, startToken: token }, null, token],
  ['malformed Linux token cannot fall back to a numeric birth', { launcher: 'resident-cli', pid: token.pid, startToken: null, createdAtUs: 1000 }, null],
]) test(name, () => {
  assert.equal(lifetimeMode(witness), expected);
  assert.deepEqual(residentIdentityPin(witness), pin);
});
