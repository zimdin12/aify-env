// Actual boot API + real state/sender/lifecycle owners. Only unmoved evaluation/sweep/stop wiring is source-executed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { bootDaemonAgentState } from '../lib/daemon-agent-state.mjs';
import { AgentTurnEvents } from '../lib/agent-turn-events.mjs';
import { ModelSelections } from '../lib/model-selections.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { SessionFolders } from '../lib/session-folders.mjs';
import { AgentStateSender, REPORT_EVERY_MS } from '../lib/agent-state-sender.mjs';
import { BootFixture } from './fixtures/daemon-boot.mjs';
import { CommsApi } from '../lib/plugins/aify-comms/api.mjs';
import { createCommsPlugin } from '../lib/plugins/aify-comms/index.mjs';
import { handleRequest } from '../lib/protocol.mjs';
const source = fs.readFileSync(new URL('../bin/aify-env.mjs', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const RESIDENTS_KEY = /^residents-[0-9a-f]{12}$/;
async function posted(f, count) {
  for (const end = Date.now() + 5000; f.calls.length < count && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10));
}
function section(start, end) {
  const a = source.indexOf(start); assert.ok(a >= 0, `actual daemon is missing ${start}`);
  const b = source.indexOf(end, a); assert.ok(b > a, `actual daemon is missing ${end}`);
  return source.slice(a, b);
}

const LIFETIME = '7f3c9e2a-0000-4000-8000-000000000001';
const STATE_PATH = '/api/v1/agent-state';

function heldComms() {
  const polls = new Map(), reports = [];
  const queues = ['definition', 'lifecycle'];
  const json = body => new Response(JSON.stringify(body));
  const fetchImpl = async (url, request) => {
    const pathname = new URL(url).pathname;
    const queue = queues.find(name => pathname.endsWith(`/${name}-requests/claim`));
    if (queue && JSON.parse(request.body).waitMs === 25_000) {
      return new Promise(resolve => {
        const answer = response => { polls.delete(queue); resolve(response); };
        const cancel = () => answer(json({ requests: [] }));
        request.signal.addEventListener('abort', cancel, { once: true });
        polls.set(queue, body => {
          request.signal.removeEventListener('abort', cancel);
          answer(body);
        });
      });
    }
    if (request.method === 'POST' && pathname === STATE_PATH) return new Response(null, { status: 204 });
    if (pathname.endsWith('/result')) reports.push({ pathname, body: JSON.parse(request.body) });
    return json({ requests: [], controls: [] });
  };
  return { polls, reports, fetchImpl, enqueue(queue, row) {
    assert.ok(polls.has(queue), `${queue} claim must already be waiting when work arrives`);
    const arrived = process.hrtime.bigint();
    let pickedUp;
    const read = new Promise(resolve => { pickedUp = resolve; });
    polls.get(queue)({ ok: true, async json() {
      pickedUp(Number(process.hrtime.bigint() - arrived) / 1e6);
      return { requests: [row] };
    } });
    return read;
  } };
}

async function boot(t, { context = null, viewOnly = false, failBoot = false, failReady = false, failLifecycle = false, comms = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'g7b-daemon-'));
  let cleanup = async () => {};
  t.after(async () => { await cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
  if (failLifecycle) {
    fs.mkdirSync(path.join(home, '.aify'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aify', 'agent-lifecycle.json'), 'invalid-json');
  }
  const definitions = new DefinitionStore({ dir: path.join(home, 'defs') });
  if (comms) {
    const definition = { name: 'Fixture', role: 'coder', harness: 'claude', mode: 'managed', workspace: home,
      model: '', effort: '', instructions: '', env: {}, herdrSpace: true };
    for (const id of ['lead', 'cold']) await definitions.set(id, definition, { installed: new Set(['claude']) });
  }
  const events = [], calls = [], intervals = [], cancelled = [], fixture = new BootFixture();
  const endpoint = 'http://fixture.invalid';
  const statePath = comms ? STATE_PATH : '/state';
  let lifecycle = null, shared = null, constructions = 0, lifecycleOwner = null, plugin = null;
  // These functions have NOT moved to boot. Retain their real entry wiring, against the actual session owner.
  const setup = section('function evaluateAgentState()', 'server.on("error"');
  const callbacks = new Function('boot', 'viewOnly', 'logLine', 'clearInterval',
    `${setup}; return { evaluateAgentState, stopAgentStateSending };`)(fixture.session, viewOnly, () => {}, id => cancelled.push(id));
  Object.assign(fixture.options, {
    home, instanceContext: context, definitions, pid: process.pid,
    runner: { instance: () => 'fixture-runner', screenSightings: () => [] }, plugins: { capabilities: () => [], capability: () => null, stopAll: async () => {} },
    identity: () => ({ hostname: 'fixture', machineId: 'win32:fixture' }), installed: () => new Set(['claude']),
    roots: () => comms ? [home] : [], env: {}, log: () => {}, evaluate: callbacks.evaluateAgentState, viewOnly: () => viewOnly,
    recover: async () => events.push('reap'), advertising: false,
    readRegistry: () => JSON.stringify({ services: { x: { endpoint: `${endpoint}/mcp/sse`, agentState: { path: statePath } } } }),
    credentialReading: () => ({ env: {}, root: path.join(home, 'credentials') }),
    timers: { set: (fn, ms) => { const timer = { fn, ms, unref() { this.unreferenced = true; } }; intervals.push(timer); return timer; }, clear: id => cancelled.push(id) },
  });
  Object.assign(fixture.factories, {
    state: options => { events.push('durable-boot'); if (failBoot) throw Error('refused');
      const state = bootDaemonAgentState({ ...options, nowMs: 1000, nowUs: () => 1000000, pid: process.pid, probe: () => new Map() });
      if (comms) state.host.startManaged({ agentId: 'lead', lifetime: LIFETIME, instance: state.instance, harness: 'claude',
        pid: 41, launcher: 'C:/fixture/claude-aify', writtenAtUs: 999_000 });
      return state; },
    turns: options => new AgentTurnEvents(options), selections: options => new ModelSelections(options),
    lifecycle: options => { events.push('lifecycle'); constructions++; lifecycleOwner = options.owner;
      lifecycle = createAgentLifecyclePorts(options); return lifecycle; },
    folders: options => new SessionFolders(options),
    sender: options => { events.push('sender'); return new AgentStateSender({ ...options, fetchImpl: async (url, request) => {
      calls.push({ url, options: request, body: JSON.parse(request.body) });
      return comms ? comms.fetchImpl(url, request) : new Response(null, { status: 204 }); } }); },
    ready: () => { events.push('ready'); if (failReady) throw Error('refused'); },
    socket: async () => null, pane: () => null, support: () => ({ available: true }),
    plugins: async options => {
      shared = options.makeShared();
      if (comms) {
        const api = new CommsApi({ endpoint, credential: async () => '', identity: { bridgeId: 'fixture-bridge' },
          fetchImpl: comms.fetchImpl });
        plugin = createCommsPlugin({ ...shared, api, advertisement: () => ({ hostname: 'fixture', kind: 'win32' }),
          setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
        await plugin.start({ processes: { list: () => [] } });
      }
      return () => {};
    },
    view: async () => ({ stop() {}, ownsScreen: false }),
  });
  let error = null;
  try { await fixture.boot(); } catch (cause) { error = cause; }
  const actual = { sender: fixture.session.sender, ...callbacks, intervals: fixture.session.evaluationTimer };
  cleanup = async () => { actual.stopAgentStateSending(); await plugin?.stop(); await fixture.session.agentState?.residents?.release();
    await fixture.session.stop('view'); await fixture.session.stop('advertising'); };
  await flush();
  return { actual, error, events, calls, intervals, cancelled, lifecycle, shared, constructions, lifecycleOwner,
    turnEvents: fixture.session.agentState?.turnEvents };
}

test('successful serving/durable boot wires actual sender and its exported evaluation cadence independent of sweep', async t => {
  const f = await boot(t); assert.equal(f.error, null, String(f.error));
  assert.equal(f.constructions, 1);
  assert.deepEqual(f.lifecycleOwner, { scope: 'http://127.0.0.1:18802', generation: 1000, pid: process.pid, createdAtUs: null });
  assert.ok(f.shared.agents.lifecycle === f.lifecycle.lifecycle && f.shared.agents.stopFacts === f.lifecycle.stopFacts);
  assert.ok(f.shared.agents.admitColdStart === f.lifecycle.admitColdStart);
  assert.equal(typeof f.shared.agents.rawIdentity, 'function');
  await posted(f, 2);
  assert.deepEqual(f.events, ['durable-boot', 'lifecycle', 'reap', 'sender', 'sender']);
  assert.deepEqual(f.calls.map(call => call.body.instance).sort().map(instance => instance.replace(RESIDENTS_KEY, 'residents-*')), ['default', 'residents-*']);
  for (const call of f.calls) {
    assert.equal(call.url, 'http://fixture.invalid/state'); assert.equal(call.body.kind, 'snapshot');
    assert.deepEqual(call.body.inputs, { operatorStop: 'tracked' });
    assert.equal(call.body.build, 'fixture-build'); assert.equal(call.body.reportEveryMs, REPORT_EVERY_MS);
  }
  assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0].unreferenced, true);
  assert.equal(f.intervals[0].ms, REPORT_EVERY_MS, 'the evaluator uses the sender-owned cadence');
  const sweep = section('const SWEEP_MS', '// ── telling'); let swept = 0, evaluated = 0, sweepTimer;
  const run = new Function('process', 'setInterval', 'reaper', 'evaluateAgentState', `let unknown; ${sweep}`);
  run({ env: { AIFY_SWEEP_MS: '177777' } }, (fn, ms) => { sweepTimer = { fn, ms, unref() {} }; return sweepTimer; },
    { sweep: () => { swept++; return { unknown: [] }; } }, () => evaluated++);
  assert.equal(sweepTimer.ms, 177777); sweepTimer.fn(); assert.equal(swept, 1); assert.equal(evaluated, 1);
  f.actual.stopAgentStateSending(); assert.equal(f.cancelled.length, 1);
  await f.intervals[0].fn(); await f.actual.evaluateAgentState(); await flush(); assert.equal(f.calls.length, 2);
  const stopView = section('  stopView: () => {', '\n  releaseResidents:').replace(/^\s*stopView: /, '').trim().replace(/,$/, '');
  const order = [], owner = { cancel: () => order.push('cancel'), stop: name => { order.push(name); return Promise.resolve(); } };
  new Function('boot', 'stopAgentStateSending', 'logLine', `return (${stopView})()`)(owner, () => order.push('sender'), () => {});
  assert.deepEqual(order, ['cancel', 'sender', 'advertising', 'view'], 'the final fence and existing synchronous stop slot remain entry-owned');
});

test('held claims leave state publication free, and pick up both queues within one second', async t => {
  const comms = heldComms();
  const f = await boot(t, { comms });
  assert.equal(f.error, null, String(f.error));
  await posted(f, 2);
  const snapshot = f.calls.find(call => call.body.instance === 'default');
  assert.equal(snapshot?.body.agents.find(row => row.agentId === 'lead')?.state, 'idle');
  assert.deepEqual([...comms.polls.keys()].sort(), ['definition', 'lifecycle'], 'both claims are already held');
  const originalHolds = new Map(comms.polls);

  const event = await handleRequest({ method: 'POST', path: '/agents/lead/turn-event', body: {
    instance: 'default', lifetime: LIFETIME, kind: 'turn-start', firedAtUs: 999_500,
  } }, { turnEvents: f.turnEvents });
  assert.equal(event.body.applied, true);
  await posted(f, 3);
  const published = f.calls.find(call => call.body.kind === 'changes' && call.body.instance === 'default');
  assert.equal(new URL(published?.url ?? 'http://missing.invalid/').pathname, STATE_PATH, 'event did not publish to the agent-state path');
  assert.equal(published.options.method, 'POST');
  const next = published.body.agents.find(row => row.agentId === 'lead');
  assert.deepEqual([next?.state, next?.lifetime], ['working', LIFETIME]);
  assert.deepEqual(comms.polls, originalHolds, 'the same held HTTP requests remained unanswered throughout publication');

  const { storeId, definitions } = await f.shared.definitions.list();
  const binding = agentId => {
    const { incarnation, revision } = definitions.find(row => row.id === agentId);
    return { agentId, storeId, expectedIncarnation: incarnation, expectedRevision: revision };
  };
  const rows = {
    definition: { ...binding('lead'), id: 'edit', patch: { model: 'fixture-model' } },
    lifecycle: { ...binding('cold'), id: 'stop-cold', machineId: 'win32:fixture', action: 'stop',
      expectedLifetime: null, requestedBy: 'operator' },
  };
  for (const [queue, row] of Object.entries(rows)) {
    const elapsedMs = await comms.enqueue(queue, row);
    t.diagnostic(`${queue} enqueue to env reading the claimed batch: ${elapsedMs.toFixed(3)} ms`);
    assert.ok(elapsedMs < 1000, `${queue} queued work was not picked up under one second`);
  }
  const end = Date.now() + 5000;
  while (comms.reports.length < 2 && Date.now() < end) await flush();
  assert.deepEqual(comms.reports.map(({ pathname, body }) => [pathname.split('/').at(-2), body.status]).sort(),
    [['edit', 'done'], ['stop-cold', 'done']], 'both claims should reach their real owners and return a result');
});

test('dedicated readiness precedes both real population senders', async t => {
  const f = await boot(t, { context: { scope: 'fixture-scope' } }); assert.equal(f.error, null, String(f.error));
  await posted(f, 2);
  assert.deepEqual(f.events, ['durable-boot', 'lifecycle', 'ready', 'sender', 'sender']);
  assert.equal(f.lifecycleOwner.scope, 'fixture-scope');
  assert.deepEqual(f.calls.map(call => call.body.instance).sort().map(instance => instance.replace(RESIDENTS_KEY, 'residents-*')), ['fixture-scope', 'residents-*']);
});

for (const options of [{ failBoot: true }, { context: { scope: 'fixture-scope' }, failReady: true }, { viewOnly: true }]) {
  test(`boot/readiness/view policy ${JSON.stringify(options)} sends no population`, async t => {
    const f = await boot(t, options);
    assert.deepEqual({ posts: f.calls.length, intervals: f.intervals.length, sender: f.events.includes('sender'), code: f.error?.exitCode ?? null },
      { posts: 0, intervals: 0, sender: false, code: options.viewOnly ? null : 2 });
  });
}

test('a damaged journal refuses lifecycle actions, not the serving host or its unavailable publications', async t => {
  const f = await boot(t, { context: { scope: 'fixture-scope' }, failLifecycle: true });
  assert.equal(f.error, null, String(f.error)); await posted(f, 2);
  assert.deepEqual(f.events, ['durable-boot', 'lifecycle', 'ready', 'sender', 'sender']);
  assert.deepEqual(f.calls.map(call => call.body.kind), ['unavailable', 'unavailable']);
});
