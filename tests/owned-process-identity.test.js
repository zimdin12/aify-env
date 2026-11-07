// The spawn-owner -> durable-record seam is not covered by raw-token or resident tests. Every child and killer here is fake.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Runner } from '../lib/runner.mjs';
import { recordStarted, readOwned } from '../lib/owned-processes.mjs';
import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
const { token } = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-identity-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'owned.json') };
}

test('recordStarted keeps the captured Linux token; legacy writes never acquire a token by probing a recorded PID', t => {
  const { file } = home(t), legacy = { id: 'old', pid: token.pid, service: 'fixture', launcher: '/fixture/launcher', owner: 123, startedAt: 1234 };
  recordStarted(file, legacy);
  assert.deepEqual(readOwned(file), [legacy]);
  const current = { ...legacy, id: 'new', startToken: token };
  recordStarted(file, current);
  assert.deepEqual(readOwned(file), [legacy, current]);
});

test('an invalid supplied owned token is not normalized into valid Linux identity', t => {
  const { file } = home(t), entry = { id: 'one', pid: token.pid, service: 'fixture', launcher: '/fixture/launcher', owner: 123, startedAt: 1234 };
  recordStarted(file, { ...entry, startToken: { ...token, pid: token.pid + 1 } });
  assert.deepEqual(readOwned(file), [{ ...entry, startToken: null }]);
});

for (const branch of ['pipe', 'terminal']) {
  test(`Runner ${branch} captures from its new child before ownership publication and preserves the token`, async t => {
    const { root, file } = home(t), captures = [];
    const child = new EventEmitter();
    Object.assign(child, { pid: token.pid, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} },
      onData() {}, onExit() {}, write() {}, resize() {}, kill() { throw Error('fake child must not be killed'); } });
    const runner = new Runner({ ownedFile: file, loadCheckpoint: null,
      openTerminal: branch === 'terminal' ? () => child : null, spawnProcess: () => spawnedPipe(child),
      processIdentity: { captureChild: supplied => {
        assert.equal(supplied, child); assert.equal(fs.existsSync(file), false, 'capture precedes durable publication');
        captures.push(supplied.pid); return token;
      } }, isAlive: () => true, killTree: async () => { throw Error('unexpected killer'); } });
    const handle = await runner.start({ service: 'fixture', command: path.join(root, 'launcher'),
      fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"', args: [], env: {} });
    assert.deepEqual(captures, [child.pid]);
    const [record] = readOwned(file);
    assert.equal(record.id, handle.id); assert.deepEqual(record.startToken, token);
    if (branch === 'pipe') child.emit('close', 0, null);
  });
}

test('a missed capture still records the owned process without inventing identity or reading an old record PID', async t => {
  const { root, file } = home(t), child = new EventEmitter(), captures = [];
  Object.assign(child, { pid: token.pid, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} } });
  const runner = new Runner({ ownedFile: file, loadCheckpoint: null, openTerminal: null, spawnProcess: () => spawnedPipe(child),
    processIdentity: { captureChild: supplied => { captures.push(supplied.pid); throw Error('unreadable own child'); } },
    isAlive: () => true, killTree: async () => { throw Error('unexpected killer'); } });
  const handle = await runner.start({ service: 'fixture', command: path.join(root, 'launcher'),
    fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"', args: [], env: {} });
  assert.deepEqual(captures, [child.pid]);
  const [record] = readOwned(file); assert.equal(record.id, handle.id);
  assert.equal(record.startToken, undefined, 'unknown capture does not synthesize a token');
  child.emit('close', 0, null);
});
