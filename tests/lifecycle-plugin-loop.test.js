import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommsPlugin } from '../lib/plugins/aify-comms/index.mjs';
import { REQUEST_POLL_MS } from '../lib/plugins/aify-comms/definition-sync.mjs';

const row = { id: 'request-1', agentId: 'agent-1', action: 'stop', expectedLifetime: 'life-1' };
const result = { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-10-07T00:00:00Z' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture({ claim, execute, report, agents = true, advertisement } = {}) {
  const calls = { claims: [], executions: [], reports: [], beats: [] };
  const timers = [];
  const lifecycle = { async execute(request) { calls.executions.push(request); return execute ? execute(request) : result; } };
  const api = {
    async heartbeat(body) { calls.beats.push(body); return {}; },
    async claim() { return {}; },
    async claimControls() { return { controls: [] }; },
    async claimLifecycleRequests(...args) { calls.claims.push(args); return claim ? claim() : { requests: [row] }; },
    async reportLifecycleRequest(...args) { calls.reports.push(args); return report?.(...args); },
  };
  const plugin = createCommsPlugin({ api, machineId: 'machine-1',
    agents: agents ? { lifecycle } : null,
    advertisement: advertisement || (() => ({ kind: 'test', hostname: 'host' })),
    cwdRoots: () => [], setTimeoutImpl: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeoutImpl: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
  });
  const host = { processes: { list: () => [] }, log: () => {} };
  async function tick() { const pending = timers.splice(0); for (const timer of pending) timer.callback(); await flush(); }
  return { plugin, host, calls, timers, tick };
}

test('plugin.start claims lifecycle requests, executes exact row and reports exact result', async () => {
  const f = fixture();
  await f.plugin.start(f.host); await flush();
  assert.deepEqual(f.calls.claims, [['test:host:default', 'machine-1']]);
  assert.deepEqual(f.calls.executions, [row]);
  assert.deepEqual(f.calls.reports, [['test:host:default', 'request-1', 'machine-1', result]]);
  assert.deepEqual(f.plugin.state().lifecycle, { requestsHandled: 1, lastError: '', accepted: true });
  assert.ok(f.timers.some(timer => timer.ms === REQUEST_POLL_MS));
  await f.tick();
  assert.equal(f.calls.claims.length, 2, 'poll repeats through the injected timer');
  await f.plugin.stop();
});

test('detach drains a pending lifecycle claim and suppresses its late execution', async () => {
  const pending = deferred(); const f = fixture({ claim: () => pending.promise });
  await f.plugin.start(f.host); await flush();
  assert.equal(f.calls.claims.length, 1, 'lifecycle claim really entered');
  let detached = false; const drain = f.plugin.detach().then(value => { detached = true; return value; });
  await flush(); assert.equal(detached, false);
  pending.resolve({ requests: [row] });
  assert.deepEqual(await drain, { detached: true, held: 0 });
  await f.tick();
  assert.deepEqual(f.calls.executions, []); assert.deepEqual(f.calls.reports, []);
  assert.equal(f.calls.claims.length, 1, 'no later lifecycle claim');
});

test('stop waits for tracked executor and its report, then suppresses later passes', async () => {
  const pending = deferred(); const f = fixture({ execute: () => pending.promise });
  await f.plugin.start(f.host); await flush();
  assert.deepEqual(f.calls.executions, [row], 'executor really entered');
  let stopped = false; const drain = f.plugin.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false, 'stop must wait for the tracked pass');
  assert.deepEqual(f.calls.reports, []);
  pending.resolve(result); await drain;
  assert.deepEqual(f.calls.reports, [['test:host:default', 'request-1', 'machine-1', result]]);
  await f.tick(); assert.equal(f.calls.claims.length, 1);
});

test('detach during lifecycle advertisement setup suppresses the first claim', async () => {
  const pending = deferred(); let reads = 0;
  const f = fixture({ advertisement: () => ++reads === 4 ? pending.promise : { kind: 'test', hostname: 'host' } });
  await f.plugin.start(f.host); await flush();
  let detached = false; const drain = f.plugin.detach().then(() => { detached = true; });
  await flush(); assert.equal(detached, false, 'setup belongs to the tracked pass');
  pending.resolve({ kind: 'test', hostname: 'host' }); await drain;
  assert.deepEqual(f.calls.claims, []); assert.deepEqual(f.calls.executions, []);
});

test('plugin without an agents lifecycle port leaves lifecycle sync disabled', async () => {
  const f = fixture({ agents: false });
  await f.plugin.start(f.host); await flush();
  assert.deepEqual(f.calls.claims, []); assert.equal(f.plugin.state().lifecycle, null);
  await f.plugin.stop();
});

test('shutdown drains a report already pending after executor completion', async () => {
  const pending = deferred(); const f = fixture({ report: () => pending.promise });
  await f.plugin.start(f.host); await flush();
  assert.equal(f.calls.reports.length, 1, 'transport report has entered');
  let stopped = false; const drain = f.plugin.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false, 'pending report remains tracked');
  pending.resolve(); await drain;
  assert.equal(f.plugin.state().lifecycle.requestsHandled, 1);
  await f.tick(); assert.equal(f.calls.claims.length, 1);
});
