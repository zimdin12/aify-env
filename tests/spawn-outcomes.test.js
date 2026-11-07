// #19: actual spawn rejection, not readiness. Existing Runner tests cover ordinary PTY/piped streams;
// these add the missing pre-spawn event boundary, transient bookkeeping and typed-error caller seams.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { HARNESS_RUNTIME } from '../lib/agent-definition-requests.mjs';
import { fixture, child, tick, failed, diagnostic, httpPost, ALLOWED } from './fixtures/spawn-outcomes.mjs';

const refused = code => ({ name: 'SpawnFailure', code, message: `spawn failed: ${code}` });

// No timers stand in for the spawn witness: the fake emits the same named event as Node.
test('PipedSpawn: a positive PID before spawn is not permission for any success bookkeeping', { timeout: 5000 }, async t => {
  const c = child(), f = fixture(t, { spawnProcess: () => c });
  const pending = f.runner.start(f.spec);
  await tick();
  const before = structuredClone(f.effects());
  c.emit('spawn');
  const handle = await pending;
  c.emit('close', 0, null); await handle.exited;
  assert.deepEqual(before, f.untouched, 'no registry, owned file or managed lifetime may be created before spawn');
  assert.ok(handle.pid > 0);
  assert.equal(f.births.length, 1, 'positive control: successful spawn really registers ownership');
  assert.ok(f.writes.some(rows => rows.some(row => row.pid === handle.pid)), 'positive control: observer sees successful disk writes');
});

test('a real missing command rejects with ENOENT and never transiently records PID zero', async t => {
  const f = fixture(t), outcome = await failed(f.runner.start(f.spec));
  await tick();
  assert.deepEqual({ diagnostic: diagnostic(outcome), effects: f.effects() },
    { diagnostic: refused('ENOENT'), effects: f.untouched });
});

test('HTTP missing-interpreter spawn returns 422 with errno, not false 201 or generic 500', async t => {
  const f = fixture(t);
  const launcher = path.join(f.home, 'launcher');
  fs.writeFileSync(launcher, `#!/usr/bin/env ${f.spec.command.split(path.sep).join('/')}\nHARNESS_WRAPPER_VERSION="1.0"\n`);
  const outcome = await failed(httpPost(t, f, { service: 'fixture', launcher },
    { platform: 'win32', readFile: file => fs.readFileSync(file, 'utf8') }));
  await tick();
  assert.deepEqual({ status: outcome.value?.status, body: outcome.value?.body, effects: f.effects() },
    { status: 422, body: { error: 'spawn failed: ENOENT' }, effects: f.untouched });
});

test('PluginProcesses propagates the same typed rejection and never opens a success pane', async t => {
  const f = fixture(t); let opened = 0;
  const processes = new PluginProcesses(f.runner, { cwdRoots: [f.home], currentCwd: () => f.home, onStarted: () => opened++ });
  const outcome = await failed(processes.start(f.spec)); await tick();
  assert.deepEqual({ diagnostic: diagnostic(outcome), opened, effects: f.effects() },
    { diagnostic: refused('ENOENT'), opened: 0, effects: f.untouched });
});

async function lifecycle(t) {
  const f = fixture(t), captured = [];
  const host = new AgentStateHost({ aifyHome: f.home, instance: 'fixture', population: 'managed', probe: () => new Map(), nowUs: () => Date.now() * 1000 }); host.boot();
  new LifecycleJournal({ file: path.join(f.home, 'agent-lifecycle.json') }).initialize({ priorBoot: false });
  const definitions = new DefinitionStore({ dir: path.join(f.home, 'definitions') });
  await definitions.set('fixture', { id: 'fixture', name: 'Fixture', role: 'worker', harness: 'claude', mode: 'managed',
    workspace: f.home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['claude']) });
  const listing = await definitions.list(), row = listing.definitions[0];
  const runner = { start: async (spec, options) => { const outcome = await failed(f.runner.start(spec, options)); captured.push(outcome.error); if (outcome.error) throw outcome.error; return outcome.value; } };
  const ports = createAgentLifecyclePorts({ aifyHome: f.home, machineId: 'fixture', stateHost: host, runner, definitions,
    probe: () => new Map(), installed: async () => new Set(['claude']), buildSpec: async () => f.spec,
    cwdRoots: [f.home], currentCwd: () => f.home });
  const request = { id: 'first', agentId: 'fixture', machineId: 'fixture', storeId: listing.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: null, action: 'start', requestedBy: 'fixture' };
  return { ...f, ports, request, captured, launch: { agentId: 'fixture', runtime: HARNESS_RUNTIME[row.agent.harness], definition: { storeId: listing.storeId, incarnation: row.incarnation, revision: row.revision } } };
}

test('the core lifecycle start port receives SpawnFailure while durable unknown custody stays unchanged', async t => {
  const f = await lifecycle(t), answer = await f.ports.lifecycle.execute(f.request);
  await tick();
  assert.deepEqual({ diagnostic: diagnostic({ error: f.captured[0] }), status: answer.status, outcome: answer.outcome, effects: f.effects() },
    { diagnostic: refused('ENOENT'), status: 'failed', outcome: 'execution-unknown', effects: f.untouched });
  assert.equal((await f.ports.lifecycle.execute({ ...f.request, id: 'second' })).outcome, 'agent-reserved');
});

test('automatic cold-start keeps its reservation on the same typed process rejection', async t => {
  const f = await lifecycle(t);
  const outcome = await failed(f.ports.admitColdStart(f.launch, () => f.runner.start(f.spec), async () => true));
  await tick();
  assert.deepEqual({ diagnostic: diagnostic(outcome), effects: f.effects() }, { diagnostic: refused('ENOENT'), effects: f.untouched });
  const again = await f.ports.admitColdStart(f.launch, () => { throw Error('must remain reserved'); }, async () => true);
  assert.equal(again.refused, 'agent-reserved');
});

test('synchronous piped creation errors are typed and sanitized before any bookkeeping', async t => {
  const f = fixture(t, { spawnProcess: () => { throw Object.assign(Error('private launcher path'), { code: 'EACCES' }); } });
  const outcome = await failed(f.runner.start(f.spec));
  assert.deepEqual({ diagnostic: diagnostic(outcome), effects: f.effects() }, { diagnostic: refused('EACCES'), effects: f.untouched });
});

test('an unsafe or absent errno does not expose arbitrary exception text in HTTP', async t => {
  const f = fixture(t, { spawnProcess: () => { throw Object.assign(Error('private launcher path'), { code: 'EACCES\nprivate' }); } });
  const result = await failed(f.post({ service: 'fixture', launcher: '/fixture' }, { platform: 'linux' }));
  assert.deepEqual({ status: result.value?.status, body: result.value?.body, effects: f.effects() },
    { status: 422, body: { error: 'spawn failed: UNKNOWN' }, effects: f.untouched });
});

test('HTTP does not relabel an unrelated Runner failure as spawn refusal', async t => {
  const f = fixture(t), cause = Error('unrelated internal failure');
  const outcome = await failed(f.post({ service: 'fixture', launcher: '/fixture' }, { platform: 'linux', runner: { start: async () => { throw cause; } } }));
  assert.equal(outcome.error, cause);
  assert.deepEqual(f.effects(), f.untouched);
});

test('early split UTF-8 output and close survive an immediate post-spawn exit in order', async t => {
  const c = child(), f = fixture(t, { spawnProcess: () => {
    queueMicrotask(() => { c.emit('spawn'); const bytes = Buffer.from('early ✻ output');
      c.stdout.emit('data', bytes.subarray(0, 7)); c.stderr.emit('data', Buffer.from('warning '));
      c.stdout.emit('data', bytes.subarray(7)); c.stdout.emit('end'); c.stderr.emit('end'); c.emit('close', 17, null); });
    return c;
  } });
  const handle = await f.runner.start(f.spec), chunks = [], exits = [];
  f.runner.subscribe(handle.id, text => chunks.push(text), (code, signal) => exits.push([code, signal]));
  await tick(); // Late exit subscribers are notified on a microtask, independently of the exit promise.
  assert.deepEqual({ text: chunks.join(''), exits, current: f.runner.list(), births: f.births.length, ended: f.ends.length },
    { text: 'early warning ✻ output', exits: [[17, '']], current: [], births: 1, ended: 1 });
  assert.equal(await handle.exited, 17);
});

test('a real child that spawns and exits immediately is still an accepted start, not readiness', async t => {
  const f = fixture(t), handle = await f.runner.start({ ...f.spec, command: process.execPath, args: ['-e', 'process.stdout.write("EARLY");process.exit(17)'] });
  const chunks = []; f.runner.subscribe(handle.id, text => chunks.push(text));
  assert.ok(handle.pid > 0); assert.equal(await handle.exited, 17); assert.equal(chunks.join(''), 'EARLY');
  assert.equal(f.births.length, 1); assert.equal(f.ends.length, 1);
});

test('an error after successful spawn is not death until close, preserving managed custody', async t => {
  const c = child(), f = fixture(t, { spawnProcess: () => { queueMicrotask(() => c.emit('spawn')); return c; } });
  const handle = await f.runner.start(f.spec), exits = [];
  f.runner.subscribe(handle.id, () => {}, (...args) => exits.push(args));
  c.emit('error', Object.assign(Error('operation refused'), { code: 'EPERM' }));
  assert.equal(f.runner.list().length, 1); assert.equal(f.ends.length, 0); assert.deepEqual(exits, []);
  c.emit('close', null, 'SIGTERM');
  assert.deepEqual(exits, [[null, 'SIGTERM']]); assert.equal(f.ends.length, 1);
});

test('a native POSIX non-executable enrolled launcher fails EACCES without bookkeeping', { skip: process.platform === 'win32' ? 'POSIX executable permission semantics only' : false }, async t => {
  const f = fixture(t), launcher = path.join(f.home, 'not-executable'); fs.writeFileSync(launcher, ALLOWED, { mode: 0o600 });
  const result = await f.post({ service: 'fixture', launcher }, { platform: process.platform, readFile: file => fs.readFileSync(file, 'utf8') }); await tick();
  assert.deepEqual({ status: result.status, body: result.body, effects: f.effects() },
    { status: 422, body: { error: 'spawn failed: EACCES' }, effects: f.untouched });
  fs.chmodSync(launcher, 0o700);
  const healthy = await f.post({ service: 'fixture', launcher }, { platform: process.platform, readFile: file => fs.readFileSync(file, 'utf8') });
  assert.equal(healthy.status, 201, 'positive control: this same enrolled launcher starts once executable');
  assert.ok(healthy.body.pid > 0);
  const code = await new Promise(resolve => f.runner.subscribe(healthy.body.id, () => {}, resolve));
  assert.equal(code, 0);
});

for (const terminal of [false, true]) {
  test(`a ${terminal ? 'PTY' : 'piped'} spawn with no usable PID cannot register success`, async t => {
    const c = child(); c.pid = undefined;
    c.onData = fn => c.on('data', fn); c.onExit = fn => c.on('pty-exit', fn);
    const spawn = () => { queueMicrotask(() => c.emit('spawn')); return c; };
    const f = fixture(t, { openTerminal: terminal ? spawn : null, spawnProcess: spawn });
    const outcome = await failed(f.runner.start(f.spec));
    c.emit('close', 0, null); c.emit('pty-exit', { exitCode: 0 });
    assert.deepEqual({ diagnostic: diagnostic(outcome), effects: f.effects() },
      { diagnostic: refused('UNKNOWN'), effects: f.untouched });
  });
}
