import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleSync } from '../lib/plugins/aify-comms/lifecycle-sync.mjs';
import { readAgentStates } from '../lib/agent-state-read.mjs';
import { CommsApi } from '../lib/plugins/aify-comms/api.mjs';

test('lifecycle claim executes exact wire row and lost report redelivers durable result', async () => {
  const row = { id: 'r', agentId: 'a', action: 'stop', expectedLifetime: 'l' };
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
  await api.claimLifecycleRequests('e/x', 'm');
  await api.reportLifecycleRequest('e/x', 'r', 'm', { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: 'now' });
  assert.ok(calls[0][0].endsWith('/environments/e%2Fx/lifecycle-requests/claim'));
  assert.deepEqual(calls[0][1], { bridgeId: 'bridge', machineId: 'm' });
  assert.ok(calls[1][0].endsWith('/environments/e%2Fx/lifecycle-requests/r/result'));
  assert.equal(calls[1][1].bridgeId, 'bridge');
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
