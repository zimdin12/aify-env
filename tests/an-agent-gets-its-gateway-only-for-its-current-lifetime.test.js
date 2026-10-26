// /agents/:id/gateway serves an agent's hermes gateway only to the lifetime this host holds current (0.9.10): the
// launcher, and comms' delivery loop through the launcher's command, prepare and register. Real route and state host;
// the book is a stand-in.
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
const LIVE = { port: 9000, token: 'tok', wsUrl: 'ws://127.0.0.1:9000/api/ws?token=tok' };

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
    prepare: async (args) => { calls.push(['prepare', args]); return { port: 9000, live: null }; },
    register: async (args) => { calls.push(['register', args]); return { registered: true }; },
    ...book,
  };
  const gateways = new AgentGateways({ host, instance: 'default', book: fake });
  const ask = (body, agentId = 'hermes-agent') => handleRequest({ method: 'POST', path: `/agents/${agentId}/gateway`, body }, { gateways });
  return { ask, calls };
}

test('THE CURRENT LIFETIME PREPARES AND REGISTERS: each reaches the book with that lifetime', async (t) => {
  const f = fixture(t);
  const prepared = await f.ask({ instance: 'default', lifetime: L1, action: 'prepare' });
  assert.deepEqual([prepared.status, prepared.body], [200, { agentId: 'hermes-agent', ok: true, port: 9000, live: false }]);
  const registered = await f.ask({ instance: 'default', lifetime: L1, action: 'register', port: 9000, pid: 77 });
  assert.deepEqual([registered.status, registered.body.ok], [200, true]);
  assert.deepEqual(f.calls, [
    ['prepare', { agentId: 'hermes-agent', lifetime: L1 }],
    ['register', { agentId: 'hermes-agent', lifetime: L1, port: 9000, pid: 77 }],
  ]);
});

test('A LIVE GATEWAY IS HANDED BACK AT PREPARE, so the launcher starts nothing', async (t) => {
  const f = fixture(t, { book: { prepare: async () => ({ port: 9000, live: LIVE }) } });
  const answer = await f.ask({ instance: 'default', lifetime: L1, action: 'prepare' });
  assert.deepEqual(answer.body, { agentId: 'hermes-agent', ok: true, port: 9000, live: true, wsUrl: LIVE.wsUrl, token: LIVE.token });
});

test('ANY OTHER LIFETIME, INSTANCE, AGENT OR ACTION IS REFUSED, and the book is never asked', async (t) => {
  const f = fixture(t);
  for (const [body, agentId, status, reason] of [
    [{ instance: 'default', lifetime: L2, action: 'prepare' }, 'hermes-agent', 409, 'not-current'],
    [{ instance: 'other', lifetime: L1, action: 'prepare' }, 'hermes-agent', 409, 'wrong-instance'],
    [{ instance: 'default', lifetime: L1, action: 'prepare' }, 'nobody', 409, 'not-current'],
    [{ instance: 'default', action: 'prepare' }, 'hermes-agent', 400, 'malformed-request'],
    [{ instance: 'default', lifetime: L1, action: 'spawn' }, 'hermes-agent', 400, 'malformed-request'],
    [{ instance: 'default', lifetime: L1, action: 'current' }, 'hermes-agent', 400, 'malformed-request'],
  ]) {
    const answer = await f.ask(body, agentId);
    assert.deepEqual([answer.status, answer.body.reason], [status, reason], JSON.stringify(body));
  }
  assert.deepEqual(f.calls, []);
});

test('A REGISTER THE BOOK REFUSES IS A 409', async (t) => {
  const f = fixture(t, { book: { register: async () => ({ registered: false }) } });
  const refused = await f.ask({ instance: 'default', lifetime: L1, action: 'register', port: 1, pid: 2 });
  assert.deepEqual([refused.status, refused.body.reason], [409, 'not-prepared']);
});

test('WITHOUT AGENT STATE the route answers 503 rather than guessing', async () => {
  const answer = await handleRequest({ method: 'POST', path: '/agents/hermes-agent/gateway', body: { instance: 'default', lifetime: L1, action: 'prepare' } }, {});
  assert.deepEqual([answer.status, answer.body.reason], [503, 'state-unavailable']);
});
