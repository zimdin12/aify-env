import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleSync } from '../lib/plugins/aify-comms/lifecycle-sync.mjs';
import { readAgentStates } from '../lib/agent-state-read.mjs';
import { CommsApi } from '../lib/plugins/aify-comms/api.mjs';
import { LIFECYCLE_ACTIONS, validRequest } from '../lib/agent-lifecycle.mjs';

/** A request this host can run: every field the lifecycle validates, overridable. */
const wire = (over = {}) => ({ id: 'r', agentId: 'a', machineId: 'm', storeId: 's', expectedIncarnation: 1, expectedRevision: 1,
  expectedLifetime: 'l', action: 'stop', requestedBy: 'operator', ...over });

test('lifecycle claim executes exact wire row and lost report redelivers durable result', async () => {
  const row = wire();
  const result = { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-10-07T00:00:00Z' };
  let reports = 0; const seen = [];
  const sync = new LifecycleSync({ machineId: 'm', lifecycle: { execute: async r => { seen.push(r); return result; } },
    api: { claimLifecycleRequests: async (e, m) => { assert.equal(e, 'e'); assert.equal(m, 'm'); return { requests: [row] }; },
      reportLifecycleRequest: async (e, id, m, answer) => { assert.deepEqual(answer, result); assert.equal(id, 'r'); if (++reports === 1) throw Error('lost'); } } });
  assert.equal((await sync.pass('e')).outcome, 'unavailable');
  assert.equal((await sync.pass('e')).outcome, 'synced'); assert.deepEqual(seen, [row, row]);
  assert.equal(sync.state.requestsHandled, 1);
});
test('quiesced lifecycle pass does not execute newly returned claim', async () => {
  let active = true; let effects = 0;
  const sync = new LifecycleSync({ machineId: 'm', mayExecute: () => active,
    lifecycle: { execute: async () => { effects++; } }, api: { claimLifecycleRequests: async () => { active = false; return { requests: [{}] }; } } });
  assert.equal((await sync.pass('e')).outcome, 'detaching'); assert.equal(effects, 0);
});
test('CommsApi lifecycle methods fence exact canonical routes', async () => {
  const calls = [];
  const api = new CommsApi({ endpoint: 'http://example.invalid', credential: async () => '',
    identity: { bridgeId: 'bridge' }, fetchImpl: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ requests: [] }) }; } });
  await api.claimLifecycleRequests('e/x', 'm', ['stop', 'release']);
  await api.reportLifecycleRequest('e/x', 'r', 'm', { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: 'now' });
  assert.ok(calls[0][0].endsWith('/environments/e%2Fx/lifecycle-requests/claim'));
  assert.deepEqual(calls[0][1], { bridgeId: 'bridge', machineId: 'm', actions: ['stop', 'release'] });
  assert.ok(calls[1][0].endsWith('/environments/e%2Fx/lifecycle-requests/r/result'));
  assert.equal(calls[1][1].bridgeId, 'bridge');
});
test('THE CLAIM DECLARES every action this host runs, from the lifecycle itself, release included', async () => {
  let declared = null;
  const sync = new LifecycleSync({ machineId: 'm', lifecycle: { execute: async () => ({}) },
    api: { claimLifecycleRequests: async (e, m, actions) => { declared = actions; return { requests: [] }; } } });
  assert.equal((await sync.pass('e')).outcome, 'synced');
  assert.deepEqual(declared, [...LIFECYCLE_ACTIONS], 'the claim does not declare what this lifecycle runs');
  assert.ok(declared.includes('release'), 'CONTROL: the newest action is declared');
});

test('ONE REQUEST THIS HOST CANNOT RUN COSTS ITSELF: reported refused, and the requests behind it still run', async () => {
  // The poison pill (2026-10-28): execute throws for an action outside its set; thrown out of the pass, that request was
  // never reported, the service handed it back first on every claim, and every later request waited behind it.
  const unknown = wire({ id: 'r1', action: 'teleport' });
  const later = wire({ id: 'r2' });
  assert.deepEqual([validRequest(later), validRequest(unknown)], [true, false], 'CONTROL: the real validator runs one and not the other');
  const done = { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: 'now' };
  const executed = [];
  const reports = [];
  const sync = new LifecycleSync({ machineId: 'm',
    lifecycle: { execute: async (request) => { executed.push(request.id); return done; } },
    api: { claimLifecycleRequests: async () => ({ requests: [unknown, later] }),
      reportLifecycleRequest: async (e, id, m, answer) => { reports.push([id, answer]); } } });
  assert.equal((await sync.pass('e')).outcome, 'synced', 'one request the host cannot run ended the pass');
  assert.deepEqual(reports.map(([id]) => id), ['r1', 'r2'], 'the request behind it never ran');
  const [, refused] = reports[0];
  assert.equal(refused.status, 'refused');
  assert.match(refused.outcome, /"teleport" is not an action this aify-env runs/);
  assert.deepEqual(reports[1][1], done);
  assert.deepEqual(executed, ['r2'], 'a request this host cannot run reached execute');
  // A fault that is not the request's still ends the pass, as before: it is not that request's to carry.
  const faultReports = [];
  const broken = new LifecycleSync({ machineId: 'm', lifecycle: { execute: async () => { throw new Error('journal unreadable'); } },
    api: { claimLifecycleRequests: async () => ({ requests: [later] }), reportLifecycleRequest: async (e, id) => { faultReports.push(id); } } });
  assert.equal((await broken.pass('e')).outcome, 'unavailable');
  assert.deepEqual(faultReports, [], "a host fault was reported as the request's refusal");
});

test('A REQUEST THIS HOST CAN RUN, whose execute throws a TypeError after acting, is NOT reported refused: the pass ends', async () => {
  // Refusing by the class of what execute threw would report `refused` for a request a bug failed midway through, after
  // it started or stopped a worker, and a reported receipt is immutable (review of ce48326).
  let effects = 0;
  const reports = [];
  const sync = new LifecycleSync({ machineId: 'm',
    lifecycle: { execute: async () => { effects++; return undefined.outcome; } },
    api: { claimLifecycleRequests: async () => ({ requests: [wire({ id: 'r3' })] }), reportLifecycleRequest: async (e, id, m, answer) => { reports.push([id, answer]); } } });
  assert.equal((await sync.pass('e')).outcome, 'unavailable');
  assert.equal(effects, 1, 'CONTROL: execute ran and acted');
  assert.deepEqual(reports, [], 'a request execute failed after acting was reported refused');
});

test('state read uses journal-backed fact and reports stop-source failure unavailable', async () => {
  const deps = { observedHarnesses: async () => new Set(['hermes']),
    definitions: { list: async () => ({ storeId: 's', definitions: [{ id: 'a', incarnation: 1, agent: { mode: 'managed', harness: 'hermes' }, problems: [] }] }) },
    stateHost: { readAll: (given) => ({ agents: [{ agentId: 'a', stopped: given.get('a').stoppedByOperator }], complete: true, problems: [] }) },
    lifecycle: { stopFacts: () => new Map([['s:1:a', true]]) } };
  const read = await readAgentStates(deps);
  assert.equal(read.body.agents[0].stopped, true); assert.equal(read.body.inputs.operatorStop, 'tracked');
  deps.lifecycle.stopFacts = () => { throw Error('unreadable'); };
  const failed = await readAgentStates(deps); assert.equal(failed.status, 503); assert.equal(failed.body.inputs.operatorStop, 'unavailable');
});
