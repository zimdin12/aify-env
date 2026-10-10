// Publication boundary only. Journal receipts are fixture inputs, not executed agent starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentStateSender } from '../lib/agent-state-sender.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-stop-'));
  const file = path.join(home, 'journal.json');
  const journal = new LifecycleJournal({ file });
  journal.initialize({ priorBoot: false });
  const definitions = new DefinitionStore({ dir: path.join(home, 'defs') });
  await definitions.set('lead', { name: 'Fixture', role: 'coder', harness: 'claude', mode: 'managed',
    workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: true }, { installed: new Set(['claude']) });
  const listing = await definitions.list();
  const reading = listing.definitions.find(r => r.id === 'lead');
  const request = { id: 'stop-1', agentId: 'lead', machineId: 'win32:fixture', storeId: listing.storeId,
    expectedIncarnation: reading.incarnation, expectedRevision: reading.revision,
    expectedLifetime: null, action: 'stop', requestedBy: 'fixture' };
  const stateHost = new AgentStateHost({ aifyHome: home, instance: 'fixture', nowUs: () => 1000000,
    probe: () => { throw new Error('No process observation is permitted in this fixture'); } });
  stateHost.boot();
  const calls = [];
  const sender = new AgentStateSender({ identity: { machineId: 'win32:fixture', instance: 'fixture', generation: 1 },
    stateHost, definitions, observedHarnesses: () => new Set(['claude']), lifecycle: journal,
    readRegistry: () => JSON.stringify({ services: { sink: { endpoint: 'http://fixture.invalid', agentState: { path: '/state' } } } }),
    credentialOptions: () => ({ root: path.join(home, 'credentials'), env: {} }),
    nowMs: () => 0, fetchImpl: async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/state');
      assert.equal(options.method, 'POST');
      calls.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    } });
  t.after(() => { sender.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const tick = async () => { await sender.tick(); await new Promise(resolve => setImmediate(resolve)); };
  return { file, journal, request, calls, tick };
}

test('sender publishes journal-backed stop, explicit-start receipt clearing, and honest unavailable input', async t => {
  const f = await fixture(t);
  assert.equal(f.journal.reserve(f.request).fresh, true);
  f.journal.markStopped(f.request);
  f.journal.finish(f.request, { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-10-07T00:00:00Z' });
  // Reload to prove that the stop comes from durable bytes, not a sender-owned cache.
  assert.equal(new LifecycleJournal({ file: f.file }).stopFacts().get(`${f.request.storeId}:${f.request.expectedIncarnation}:lead`), true);
  await f.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'snapshot');
  assert.deepEqual(f.calls[0].inputs, { operatorStop: 'tracked' });
  assert.deepEqual(f.calls[0].agents.map(r => [r.state, r.stateCause]), [['stopped', 'operator-stop']]);

  const start = { ...f.request, id: 'start-1', action: 'start' };
  assert.equal(f.journal.reserve(start).fresh, true);
  // Actual journal success-clearing operation. No provider or process start is fabricated or invoked.
  f.journal.finish(start, { status: 'done', outcome: 'start', resultLifetime: 'fixture-start-receipt', finishedAt: '2026-10-07T00:00:01Z' }, false);
  assert.equal(new LifecycleJournal({ file: f.file }).stopFacts().get(`${start.storeId}:${start.expectedIncarnation}:lead`), false);
  await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].kind, 'changes');
  assert.deepEqual(f.calls[1].inputs, { operatorStop: 'tracked' });
  assert.deepEqual(f.calls[1].agents.map(r => [r.state, r.stateCause]), [['available', 'startable']]);

  const saved = fs.readFileSync(f.file);
  fs.writeFileSync(f.file, '{malformed journal');
  await f.tick();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].kind, 'unavailable');
  assert.deepEqual(f.calls[2].inputs, { operatorStop: 'unavailable' });
  assert.equal(Object.hasOwn(f.calls[2], 'agents'), false);
  assert.equal(Object.hasOwn(f.calls[2], 'removed'), false);
  fs.writeFileSync(f.file, saved);
  await f.tick();
  assert.equal(f.calls.length, 3, 'unavailable ACK must not replace the prior complete view');
  assert.deepEqual(f.calls.map(b => b.publication), [1, 2, 3]);
});
