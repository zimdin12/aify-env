import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
// R3: a settled return is not necessarily proof, including truthy but malformed stop values.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createShutdown } from '../lib/shutdown.mjs';
import { Runner } from '../lib/runner.mjs';
import { readOwned } from '../lib/owned-processes.mjs';

for (const [name, answer] of [['undefined', undefined], ['null', null], ['empty object', {}],
  ['string false', { stopped: 'false' }], ['string true', { stopped: 'true' }], ['numeric true', { stopped: 1 }]]) {
  test(`shutdown keeps ownership for ${name} stop proof without calling it a wedge`, async () => {
    let cleared = 0, exited = 0, attempted = 0;
    const lines = [];
    await createShutdown({ runner: { list: () => [{ id: 'held', pid: 424242 }],
      stop: () => { attempted++; return answer; } }, clearOwned: () => { cleared++; },
      exit: () => { exited++; }, write: text => lines.push(text) })('fixture');
    assert.equal(attempted, 1);
    assert.equal(exited, 1, 'unknown proof must not wedge shutdown');
    assert.equal(cleared, 0, 'only explicit stopped=true permits ownership erasure');
    assert.match(lines.join(''), /stop-unverified/);
    assert.doesNotMatch(lines.join(''), /did not confirm within/, 'settled uncertainty is not a timeout');
  });
}

test('explicit stopped=true is the healthy shutdown proof', async () => {
  let cleared = 0;
  await createShutdown({ runner: { list: () => [{ id: 'held' }], stop: () => ({ stopped: true }) },
    clearOwned: () => { cleared++; }, exit: () => {} })('fixture');
  assert.equal(cleared, 1);
});

test('a real Runner matching exit permits shutdown to clear owned records', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'shutdown-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownedFile = path.join(root, 'owned.json'), effects = [];
  const child = new EventEmitter();
  Object.assign(child, { pid: 424242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} },
    kill: () => { effects.push('console'); child.emit('close', null, 'SIGTERM'); } });
  const runner = new Runner({ openTerminal: null, loadCheckpoint: null, spawnProcess: () => spawnedPipe(child),
    isAlive: () => true, ownedFile, processIdentity: { captureChild: () => null }, // synthetic PID: no native observation
    killTree: async () => { effects.push('tree'); } });
  const handle = await runner.start({ service: 'fixture', command: 'fixture', env: {},
    fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"' });
  assert.equal(readOwned(ownedFile)[0]?.id, handle.id, 'control: ownership exists before stop');
  let cleared = 0, exited = 0;
  await createShutdown({ runner, clearOwned: () => { cleared++; fs.writeFileSync(ownedFile, '[]'); },
    exit: () => { exited++; } })('fixture');
  assert.equal(cleared, 1);
  assert.equal(exited, 1);
  assert.deepEqual(effects, ['console', 'tree']);
  assert.deepEqual(runner.list(), []);
  assert.deepEqual(readOwned(ownedFile), []);
});
