import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommsPlugin } from '../lib/plugins/aify-comms/index.mjs';
import { CommsApi } from '../lib/plugins/aify-comms/api.mjs';
import { LifecycleSync } from '../lib/plugins/aify-comms/lifecycle-sync.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/terminal-controls.mjs';
import { createOutputSender } from '../lib/plugins/aify-comms/output-sender.mjs';
import { buildStartSpec } from '../lib/start-spec.mjs';
import { workspaceWithinRoots } from '../lib/plugins/aify-comms/claim.mjs';

const request = { id: 'r', agentId: 'a', machineId: 'm', storeId: 's', expectedIncarnation: 2,
  expectedRevision: 3, expectedLifetime: null, action: 'start' };
const agent = { id: 'a', mode: 'managed', harness: 'hermes' };
const launcher = 'C:/sealed/wrapper';
const launch = { agentId: 'a', runtime: 'hermes', terminalId: 't', argv: [launcher, '--session', 'native'],
  cwd: 'C:/sealed/work', definition: { storeId: 's', incarnation: 2, revision: 3 },
  env: { OWN: 'overlay' }, unsetEnv: ['STRIP'], cols: 91, rows: 24, herdrSpace: false };
const tick = () => new Promise(resolve => setImmediate(resolve));
const runLocked = async produce => ({ produced: await produce() });
async function fixture(patch = {}) {
  const { LifecycleLaunch } = await import('../lib/plugins/aify-comms/lifecycle-launch.mjs');
  const events = []; const posts = []; const handles = createHandleBook(); let output; let exit; let released = 0;
  const api = { prepareLifecycleLaunch: async (...args) => { events.push(['prepare', ...args]); return { ok: true, launch: { ...launch, ...patch.launch } }; },
    reportLifecycleAttachment: async (...args) => { events.push(['attachment', ...args]); if (patch.attachmentError) throw Error('attachment-lost'); return { ok: true, attachment: args[3] }; },
    terminalOutput: async (id, body) => { posts.push([id, body]); } };
  const processes = { list: () => [], start: async spec => { events.push(['start', spec]); return { id: 'runner-new', pid: 123, cols: 91, rows: 24, ...patch.started }; },
    subscribe: (id, onOutput, onExit) => { events.push(['subscribe', id]); output = onOutput; exit = onExit; return patch.subscriptionFails ? null : () => { released++; }; } };
  const definitions = { list: async () => ({ storeId: 's', definitions: [{ id: 'a', incarnation: 2, revision: 3, agent, problems: [] }] }),
    admitStart: () => { throw Error('adapter must not nest definition lock'); } };
  const adapter = new LifecycleLaunch({ api, processes, definitions, machineId: 'm', handles,
    identity: async id => { events.push(['identity', id]); return patch.identity || { conflict: false, unknown: false,
      current: { agentId: 'a', handle: 'runner-new', pid: 123, lifetime: 'actual-new-lifetime' } }; },
    cwdRoots: async () => ['C:/sealed/work'], windows: true, withinRoots: workspaceWithinRoots,
    baseEnv: { OWN: 'inherited', STRIP: 'remove', KEEP: 'yes' }, resolveCandidates: () => ['C:/sealed/rejected', launcher],
    buildSpec: spec => buildStartSpec(spec, { platform: 'linux', dirExists: () => false,
      readFile: file => file.endsWith('rejected') ? 'not enrolled' : '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1"\n' }),
    sender: createOutputSender({ post: (id, body) => api.terminalOutput(id, body), status: 'attached' }) });
  return { adapter, api, events, posts, handles, output: value => output(value), exit: (...args) => exit(...args), released: () => released };
}

test('attachment transport reaches an integer-accepting service consumer', async () => {
  const f = await fixture(); const bodies = [];
  const transport = new CommsApi({ endpoint: 'http://example.invalid', identity: { bridgeId: 'b' }, credential: async () => '',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      assert.ok(Number.isSafeInteger(body.processId) && body.processId > 0, 'service requires integer processId');
      return { ok: true, json: async () => ({ ok: true, attachment: body }) };
    } });
  f.api.reportLifecycleAttachment = (...args) => transport.reportLifecycleAttachment(...args);
  await f.adapter.start('e', await f.adapter.prepare('e', request, agent), runLocked);
  assert.equal(bodies[0].processId, 123); assert.equal(bodies[0].bridgeId, 'b');
});

test('API sends exact launch and attachment requests with its own bridge identity', async () => {
  const calls = [];
  const api = new CommsApi({ endpoint: 'http://example.invalid', identity: { bridgeId: 'actual-bridge' }, credential: async () => '',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST');
      assert.match(url, /\/environments\/e%2Fx\/lifecycle-requests\/r%2Fx\/(launch|attachment)$/);
      calls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ ok: true }) };
    } });
  await api.prepareLifecycleLaunch('e/x', 'r/x', 'm');
  const receipt = { terminalId: 't', handle: 'h', processId: '123', lifetime: 'life', cols: 90, rows: 20, bridgeId: 'forged' };
  await api.reportLifecycleAttachment('e/x', 'r/x', 'm', receipt);
  assert.deepEqual(calls[0][1], { bridgeId: 'actual-bridge', machineId: 'm' });
  assert.deepEqual(calls[1][1], { ...receipt, bridgeId: 'actual-bridge', machineId: 'm' });
});

test('new managed launch uses actual spec, runner subscription and poststart lifetime before attachment', async () => {
  const f = await fixture(); const prepared = await f.adapter.prepare('e', request, agent);
  assert.equal(f.events.filter(e => e[0] === 'start').length, 0);
  await f.adapter.start('e', prepared, runLocked);
  assert.deepEqual(f.events.map(e => e[0]), ['prepare', 'start', 'subscribe', 'identity', 'attachment']);
  const spec = f.events.find(e => e[0] === 'start')[1];
  assert.equal(spec.command, launcher); assert.equal(spec.launcher, launcher); assert.equal(spec.id, 't'); assert.equal(spec.agentId, 'a');
  assert.deepEqual(spec.args, ['--session', 'native']); assert.equal(spec.space, false);
  assert.deepEqual(spec.env, { OWN: 'overlay', KEEP: 'yes' });
  assert.deepEqual(f.events.at(-1).slice(1), ['e', 'r', 'm', { terminalId: 't', handle: 'runner-new', processId: 123,
    lifetime: 'actual-new-lifetime', cols: 91, rows: 24 }]);
  assert.equal(f.handles.handleFor('t'), 'runner-new');
  f.output('TAIL'); await tick(); f.exit(0, 'SIGTERM'); await f.handles.exitMarkersSettled();
  assert.deepEqual(f.posts.map(p => p[1].output), ['TAIL', '\n[terminal exited]\n']);
  assert.equal(f.posts.at(-1)[1].exitCode, 0); assert.equal(f.posts.at(-1)[1].exitSignal, 'SIGTERM');
  assert.equal(f.handles.handleFor('t'), ''); assert.equal(f.released(), 1);
});

for (const [name, bad] of Object.entries({ root: { cwd: 'C:/elsewhere' }, runtime: { runtime: 'codex' },
  agent: { agentId: 'b' }, tuple: { definition: { storeId: 's', incarnation: 2, revision: 4 } },
  argv: { argv: [] }, malformedArgv: { argv: [launcher, 42] } })) {
  test(`preparation refuses ${name} before any child`, async () => {
    const f = await fixture({ launch: bad });
    await assert.rejects(f.adapter.prepare('e', request, agent));
    assert.equal(f.events.filter(e => e[0] === 'start').length, 0);
  });
}
for (const [name, patch] of Object.entries({ subscription: { subscriptionFails: true }, attachment: { attachmentError: true },
  lifetime: { identity: { conflict: false, unknown: false, current: null } },
  wrongWorker: { identity: { conflict: false, unknown: false, current: { agentId: 'a', handle: 'old', pid: 999, lifetime: 'old' } } } })) {
  test(`poststart ${name} failure propagates without retry or cleanup`, async () => {
    const f = await fixture(patch); const prepared = await f.adapter.prepare('e', request, agent);
    await assert.rejects(f.adapter.start('e', prepared, runLocked));
    assert.equal(f.events.filter(e => e[0] === 'start').length, 1); assert.equal(f.handles.handleFor('t'), 'runner-new');
    if (!patch.attachmentError) assert.equal(f.events.filter(e => e[0] === 'attachment').length, 0);
    f.handles.forget('t');
  });
}

test('LifecycleSync passes invocation-bound preparation/start callbacks to the generic owner', async () => {
  const seen = []; const prepared = { spec: 'prepared' };
  const plugin = { prepare: async (...args) => { seen.push(args); return prepared; }, start: async (...args) => { seen.push(args); } };
  const sync = new LifecycleSync({ api: { claimLifecycleRequests: async () => ({ requests: [request] }),
    reportLifecycleRequest: async () => {} }, machineId: 'm', plugin,
    lifecycle: { execute: async (row, callbacks) => { assert.equal(row, request); assert.ok(callbacks);
      await callbacks.start(await callbacks.buildSpec(agent, row), runLocked); return { status: 'done' }; } } });
  assert.equal((await sync.pass('e')).outcome, 'synced');
  assert.deepEqual(seen, [['e', request, agent], ['e', prepared, runLocked]]);
});

test('tracked plugin lifecycle loop supplies its launch adapter callbacks', async () => {
  let callbacks;
  const plugin = createCommsPlugin({ api: { heartbeat: async () => ({}), claim: async () => ({}),
    claimControls: async () => ({ controls: [] }), claimLifecycleRequests: async () => ({ requests: [request] }),
    reportLifecycleRequest: async () => {} }, machineId: 'm',
    agents: { lifecycle: { execute: async (row, ports) => { callbacks = ports; return { status: 'done' }; } }, rawIdentity: () => ({}) },
    advertisement: () => ({ kind: 'test', hostname: 'host' }), cwdRoots: () => [],
    setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  await plugin.start({ processes: { list: () => [] }, log: () => {} }); await tick();
  assert.equal(typeof callbacks?.buildSpec, 'function'); assert.equal(typeof callbacks?.start, 'function');
  await plugin.stop();
});

for (const pid of [0, -1, '123', true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid runner PID ${typeof pid}:${String(pid)} cannot be transported or retried`, async () => {
    const f = await fixture({ started: { pid } });
    const prepared = await f.adapter.prepare('e', request, agent);
    await assert.rejects(f.adapter.start('e', prepared, runLocked), /lifetime-unavailable/);
    assert.equal(f.events.filter(e => e[0] === 'attachment').length, 0);
    await assert.rejects(f.adapter.start('e', prepared, runLocked), /not-prepared/);
    assert.equal(f.events.filter(e => e[0] === 'start').length, 1);
    f.handles.forget('t');
  });
}
