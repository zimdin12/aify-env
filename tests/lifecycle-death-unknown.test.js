import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { Runner } from '../lib/runner.mjs';
import { stopAndVerify } from '../lib/verified-stop.mjs';

const unanswered = [
  ['null', null], ['undefined', undefined], ['numeric zero', 0], ['empty string', ''],
  ['NaN', NaN], ['string false', 'false'], ['numeric one', 1], ['object', {}],
];
const unreadable = () => { throw Object.assign(new Error('probe unavailable'), { code: 'EACCES' }); };

// Exercise real registration and retained raw ownership without creating or probing an OS process.
async function managed(t, isAlive) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'd9-death-unknown-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = new AgentStateHost({ aifyHome: home, instance: 'owner',
    probe: () => { throw new Error('unexpected resident probe'); }, nowUs: () => 1700000000001000 });
  host.boot();
  const child = new EventEmitter();
  child.pid = 424242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const effects = [], probes = [];
  child.stdin = { write() {} }; child.kill = () => effects.push('child');
  const runner = new Runner({ openTerminal: null, loadCheckpoint: null, ownedFile: null,
    spawnProcess: () => child, managedHost: () => ({ host, instance: 'owner', url: 'http://127.0.0.1:12345' }),
    isAlive: pid => { probes.push(pid); return isAlive(pid); },
    killTree: async pid => { assert.equal(pid, child.pid); effects.push('tree'); } });
  const handle = await runner.start({ agentId: 'a', service: 'fixture', command: 'fixture', args: [], env: {},
    fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"' });
  child.stdout.emit('data', 'retained output');
  return { host, runner, child, handle, effects, probes };
}

for (const [name, value] of [...unanswered, ['throws', unreadable]]) {
  test(`Runner.stop refuses ${name} before effects and preserves captured managed state`, async t => {
    const f = await managed(t, name === 'throws' ? value : () => value);
    const raw = f.host.rawIdentity('a'), listed = f.runner.list(), history = f.runner.history();
    assert.equal(raw.current?.handle, f.handle.id); assert.equal(raw.current?.pid, f.child.pid);
    assert.equal(typeof raw.current?.lifetime, 'string'); assert.equal(raw.unknown, false);
    const phases = [];
    await assert.rejects(f.runner.stop(f.handle.id, { phase: p => phases.push(p) }), /liveness|unknown|probe unavailable/i);
    assert.deepEqual(f.probes, [f.child.pid]);
    assert.deepEqual(f.effects, []); assert.deepEqual(phases, []);
    assert.deepEqual(f.host.rawIdentity('a'), raw);
    assert.deepEqual(f.runner.list(), listed); assert.deepEqual(f.runner.history(), history);
    assert.equal(f.runner.canStream(f.handle.id), true);
    const replay = []; const unsubscribe = f.runner.subscribe(f.handle.id, text => replay.push(text));
    assert.equal(typeof unsubscribe, 'function'); assert.deepEqual(replay, ['retained output']); unsubscribe();
    // A later observed close still ends the original lifetime, so retention is not a leaked copy.
    f.child.emit('close', null, 'SIGTERM');
    assert.equal(f.host.rawIdentity('a').current, null);
  });
}

test('Runner.stop true-live attempts fake effects but registry release does not prove death', async t => {
  const f = await managed(t, () => true), raw = f.host.rawIdentity('a'), phases = [];
  await f.runner.stop(f.handle.id, { phase: p => phases.push(p) });
  assert.deepEqual(f.probes, [f.child.pid]); assert.deepEqual(f.effects, ['child', 'tree']);
  assert.deepEqual(phases, ['console-kill', 'tree-kill', 'done']);
  assert.deepEqual(f.runner.list(), []); assert.equal(f.runner.canStream(f.handle.id), false);
  assert.deepEqual(f.host.rawIdentity('a'), raw);
});

test('Runner.stop strict false ends managed lifetime without fake kill effects', async t => {
  const f = await managed(t, () => false);
  assert.ok(f.host.rawIdentity('a').current?.lifetime);
  await f.runner.stop(f.handle.id);
  assert.deepEqual(f.probes, [f.child.pid]); assert.deepEqual(f.effects, []);
  assert.equal(f.host.rawIdentity('a').current, null); assert.deepEqual(f.runner.list(), []);
});

for (const [name, value] of [...unanswered, ['true-live', true], ['false-dead', false], ['throws', unreadable]]) {
  test(`stopAndVerify requires strict false after captured PID release: ${name}`, async () => {
    let listed = [{ id: 'captured', pid: 424242 }]; const stopped = [], probed = [];
    const runner = { list: () => listed, stop: async id => { stopped.push(id); listed = []; } };
    const result = await stopAndVerify(runner, 'captured', { settleMs: 0,
      isAlive: pid => { probed.push(pid); return name === 'throws' ? value() : value; } });
    assert.deepEqual(stopped, ['captured']); assert.deepEqual(probed, [424242]); assert.deepEqual(listed, []);
    assert.equal(result.stopped, value === false);
    if (value === false) assert.equal(result.problem, '');
    else if (value === true) assert.match(result.problem, /still running/);
    else assert.match(result.problem, /could not be checked|unknown/i);
  });
}

test('stopAndVerify retries unanswered liveness and only subsequent strict false proves death', async () => {
  let checks = 0;
  const result = await stopAndVerify({ list: () => [{ id: 'captured', pid: 424242 }], stop: async () => {} },
    'captured', { isAlive: () => ++checks === 1 ? undefined : false, settleMs: 1000, stepMs: 0 });
  assert.equal(checks, 2); assert.deepEqual(result, { stopped: true, problem: '' });
});

test('captured managed witness remains after true-live stop and unanswered verification', async t => {
  const f = await managed(t, () => true), raw = f.host.rawIdentity('a');
  const result = await stopAndVerify({ list: () => [{ id: raw.current.handle, pid: raw.current.pid }],
    stop: id => f.runner.stop(id) }, raw.current.handle, { isAlive: () => undefined, settleMs: 0 });
  assert.equal(result.stopped, false); assert.deepEqual(f.effects, ['child', 'tree']);
  assert.deepEqual(f.runner.list(), []); assert.deepEqual(f.host.rawIdentity('a'), raw);
});
