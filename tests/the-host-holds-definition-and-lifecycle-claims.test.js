import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsApi } from '../lib/plugins/aify-comms/api.mjs';
import { createCommsPlugin } from '../lib/plugins/aify-comms/index.mjs';
import { LIFECYCLE_ACTIONS } from '../lib/agent-lifecycle.mjs';
import { claimBatch } from '../lib/plugins/aify-comms/request-claim.mjs';

const bodyFor = requests => ({ ok: true, requests });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const queues = ['definition', 'lifecycle'];
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, mode) {
  let now = 0, stopping = false;
  const ready = new Map(), requests = [], snapshots = [], timers = new Map(), deadlines = new Map();
  const claimSignals = [], unrelated = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  t.mock.method(AbortSignal, 'timeout', ms => {
    const signal = new AbortController().signal;
    deadlines.set(signal, ms);
    return signal;
  });
  const api = new CommsApi({ endpoint: 'http://127.0.0.1:1', identity: { bridgeId: 'bridge-1' }, credential: async () => '',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      const queue = queues.find(kind => path.endsWith(`/${kind}-requests/claim`));
      if (queue) {
        const body = JSON.parse(init.body);
        const request = { queue, at: now, body, signal: init.signal, deadline: [...deadlines.values()].at(-1) };
        requests.push(request);
        // Tripwire for an immediate-retry mutant, so it cannot starve the simulated clock.
        if (requests.length > 24) return new Promise(resolve => unrelated.push(resolve));
        if (stopping || !body.waitMs || mode === 'ignore') return response(bodyFor([]));
        if (mode === 'error') return response({}, 503);
        const held = mode === 'slow-unmarked' ? {} : { held: true };
        return new Promise((resolve, reject) => {
          const complete = () => { ready.delete(queue); resolve(response({ ...bodyFor([]), ...held })); };
          claimSignals.push(init.signal);
          init.signal.addEventListener('abort', () => { ready.delete(queue); reject(init.signal.reason); }, { once: true });
          ready.set(queue, { at: now + (mode === 'held-short' ? 8_000 : body.waitMs), complete });
        });
      }
      if (path.endsWith('/environments/heartbeat')) return response({});
      if (path.endsWith('/agent-definitions')) { snapshots.push(now); return response({ ok: true }); }
      if (path.endsWith('/claim')) return new Promise(resolve => unrelated.push(resolve));
      throw new Error(`unexpected fake Comms route: ${path}`);
    },
  });
  const plugin = createCommsPlugin({ api, machineId: 'machine-1', advertisement: () => ({ kind: 'test', hostname: 'fixture' }),
    definitions: { snapshot: async () => ({ complete: true, revision: 1, entries: [] }) },
    agents: { lifecycle: { execute() { throw new Error('an idle fake server handed out a lifecycle request'); } } },
    setTimeoutImpl(fn, delay) { const token = {}; timers.set(token, { fn, at: now + delay }); return token; },
    clearTimeoutImpl(token) { timers.delete(token); },
  });
  t.after(async () => {
    stopping = true;
    const done = plugin.stop();
    for (const entry of ready.values()) entry.complete();
    for (const resolve of unrelated) resolve(response({}));
    await done;
  });
  await plugin.start({ processes: { list: () => [] } });
  await flush();
  return {
    requests, ready, claimSignals, snapshots, plugin,
    async until(end) {
      // Exclusive horizon, so a queued callback at end never contributes to the count.
      for (let step = 0; step < 100; step++) {
        const next = Math.min(end, ...[...timers.values(), ...ready.values()].map(event => event.at));
        if (next === end) return;
        now = next;
        for (const [token, event] of timers) if (event.at === now) { timers.delete(token); event.fn(); }
        for (const entry of ready.values()) if (entry.at === now) entry.complete();
        await flush();
      }
      assert.fail('claims did not move through the fixed span');
    },
    byQueue: queue => requests.filter(request => request.queue === queue),
  };
}

const oldCadence = [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000];
for (const [mode, expected] of [
  ['hold', [0, 25_000, 50_000]],
  ['held-short', [0, 8_000, 16_000, 24_000, 32_000, 40_000, 48_000, 56_000]],
  ['slow-unmarked', [0, 35_000]],
  ['ignore', oldCadence],
  ['error', oldCadence],
]) {
  test(`${mode}: idle claims over the same 61-second window`, async t => {
    const f = await fixture(t, mode);
    await f.until(61_000);
    for (const queue of queues) t.diagnostic(`${queue} claim requests started: ${f.byQueue(queue).length}`);
    for (const queue of queues) {
      const captured = f.byQueue(queue);
      assert.deepEqual(captured.map(row => row.at), expected, `${queue}: wrong idle request cadence in ${mode} mode`);
      if (mode === 'hold') {
        assert.ok(captured.every(row => row.body.waitMs === 25_000 && row.deadline === 35_000), `${queue}: wrong hold or deadline`);
        assert.ok(captured.every(row => row.body.bridgeId === 'bridge-1' && row.body.machineId === 'machine-1'));
      }
    }
    if (mode === 'hold') {
      assert.deepEqual(f.snapshots, [0], 'the first snapshot must publish before the first idle hold returns');
      assert.deepEqual(f.byQueue('lifecycle')[0].body.actions, [...LIFECYCLE_ACTIONS]);
      assert.deepEqual(f.byQueue('lifecycle')[0].body.capabilities, ['automatic-start-v1']);
    }
  });
}

test('stop cancels both pending HTTP claims without waiting for their server deadlines', async t => {
  const f = await fixture(t, 'hold');
  const waiting = [...f.ready.values()];
  assert.equal(waiting.length, 2, 'both held HTTP calls must actually be in flight');
  let stopped = false;
  const stopping = f.plugin.stop().then(() => { stopped = true; });
  await flush();
  const returnedBeforeServer = stopped;
  const canceled = f.claimSignals.map(signal => signal.aborted);
  for (const entry of waiting) entry.complete();
  await stopping;
  assert.deepEqual(canceled, [true, true], 'stop did not abort both held HTTP requests');
  assert.equal(returnedBeforeServer, true, 'stop waited for the fake server to release a claim');
  assert.equal(f.requests.length, 2, 'stop re-armed a canceled call');
});

test('a malformed batch is not an empty claim that can be re-armed', async () => {
  await assert.rejects(claimBatch(async () => ({ requests: {} }), 'definition'), /invalid definition claim/);
});
