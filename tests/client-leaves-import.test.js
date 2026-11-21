import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock, test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';

new ProcessEffectTripwire();

test('both public client entries load without filesystem or child-process work', async () => {
  const calls = [];
  const trip = (name, original = null) => (...args) => {
    // Node 22's loader reads source through the public fs export; only that caller may do so.
    if (original && new Error().stack.includes('getSourceSync (node:internal/modules/esm/load:')) return original(...args);
    calls.push(name); throw Error(`client leaf touched ${name} at import`);
  };
  const methods = ['readFileSync', 'statSync', 'lstatSync', 'openSync', 'writeFileSync', 'mkdirSync'];
  const promises = ['readFile', 'stat', 'lstat', 'open', 'writeFile', 'mkdir', 'realpath'];
  const holds = [];
  for (const name of methods) holds.push(mock.method(fs, name, trip(name, name === 'readFileSync' || name === 'openSync' ? fs[name] : null)));
  for (const name of promises) holds.push(mock.method(fsp, name, trip(name)));
  holds.push(mock.method(fs.realpathSync, 'native', trip('realpathSync.native')));
  holds.push(mock.method(fs.realpath, 'native', trip('realpath.native')));
  syncBuiltinESMExports();
  try {
    const ids = await import('aify-env/client/machine-id');
    const credentials = await import('aify-env/client/credentials');
    assert.equal(typeof ids.machineIdFor, 'function');
    assert.equal(typeof credentials.resolveServiceKey, 'function');
    assert.equal(typeof credentials.resolveServiceKeySync, 'function');
    assert.deepEqual(calls, []);
  } finally {
    for (const fn of holds) fn.mock.restore();
    syncBuiltinESMExports();
  }
});
