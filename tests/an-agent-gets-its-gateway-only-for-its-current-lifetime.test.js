// /agents/:id/gateway hands an agent its hermes gateway only for the lifetime this host holds current, tied to the pid
// this host recorded, never to one the request names (0.9.10). Real route and state host; the book is a stand-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentGateways } from '../lib/agent-gateways.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { handleRequest } from '../lib/protocol.mjs';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const GATEWAY = { port: 9000, token: 'tok', wsUrl: 'ws://127.0.0.1:9000/api/ws?token=tok' };

function fixture(t, { book = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-gw-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nowUs = Date.now() * 1000;
  const host = new AgentStateHost({ aifyHome: home, instance: 'default', nowUs: () => nowUs, probe: () => new Map() });
  host.boot();
  host.startManaged({ agentId: 'hermes-agent', lifetime: L1, instance: 'default', harness: 'hermes', pid: 4321,
    launcher: '/owned/hermes-aify', writtenAtUs: nowUs - 1000 });
  const calls = [];
  const fake = {
    ensure: async (args) => { calls.push(['ensure', args]); return GATEWAY; },
    current: async (args) => { calls.push(['current', args]); return GATEWAY; },
    ...book,
  };
  const gateways = new AgentGateways({ host, instance: 'default', book: fake });
  const ask = (body, agentId = 'hermes-agent') => handleRequest({ method: 'POST', path: `/agents/${agentId}/gateway`, body }, { gateways });
  return { ask, calls };
}

test('THE CURRENT LIFETIME GETS ITS GATEWAY, owned by the pid this host recorded, not the one it was told', async (t) => {
  const f = fixture(t);
  const answer = await f.ask({ instance: 'default', lifetime: L1, ensure: true, ownerPid: 1 });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { agentId: 'hermes-agent', ok: true, ...GATEWAY });
  assert.deepEqual(f.calls, [['ensure', { agentId: 'hermes-agent', lifetime: L1, ownerPid: 4321 }]]);
  const asked = await f.ask({ instance: 'default', lifetime: L1 });
  assert.equal(asked.status, 200);
  assert.equal(f.calls.at(-1)[0], 'current', 'without ensure nothing is started');
});

test('ANY OTHER LIFETIME, INSTANCE OR AGENT IS REFUSED, and the book is never asked', async (t) => {
  const f = fixture(t);
  for (const [body, agentId, status, reason] of [
    [{ instance: 'default', lifetime: L2, ensure: true }, 'hermes-agent', 409, 'not-current'],
    [{ instance: 'other', lifetime: L1, ensure: true }, 'hermes-agent', 409, 'wrong-instance'],
    [{ instance: 'default', lifetime: L1, ensure: true }, 'nobody', 409, 'not-current'],
    [{ instance: 'default', ensure: true }, 'hermes-agent', 400, 'malformed-request'],
  ]) {
    const answer = await f.ask(body, agentId);
    assert.deepEqual([answer.status, answer.body.reason], [status, reason], JSON.stringify(body));
  }
  assert.deepEqual(f.calls, []);
});

test('NO GATEWAY IS A 404, AND A START THAT FAILED SAYS WHY', async (t) => {
  const none = fixture(t, { book: { current: async () => null } });
  assert.deepEqual((await none.ask({ instance: 'default', lifetime: L1 })).body.reason, 'no-gateway');
  const failing = fixture(t, { book: { ensure: async () => { throw new Error('hermes could not start for port 9000: ENOENT'); } } });
  const answer = await failing.ask({ instance: 'default', lifetime: L1, ensure: true });
  assert.equal(answer.status, 502);
  assert.deepEqual([answer.body.reason, answer.body.detail], ['gateway-failed', 'hermes could not start for port 9000: ENOENT']);
});

test('WITHOUT AGENT STATE the route answers 503 rather than guessing', async () => {
  const answer = await handleRequest({ method: 'POST', path: '/agents/hermes-agent/gateway', body: { instance: 'default', lifetime: L1 } }, {});
  assert.deepEqual([answer.status, answer.body.reason], [503, 'state-unavailable']);
});
