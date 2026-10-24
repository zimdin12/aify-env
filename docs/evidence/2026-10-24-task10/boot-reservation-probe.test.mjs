// Task #10 diagnosis on unchanged product. No daemon, child, socket or live registry is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DefinitionStore } from '../../../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../../../lib/agent-lifecycle.mjs';
import { bootDaemonAgentState } from '../../../lib/daemon-agent-state.mjs';
import { createAgentLifecyclePorts } from '../../../lib/daemon-agent-lifecycle.mjs';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'task10-reservation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  await definitions.set('dashboard-manager', { name: 'Fixture', role: 'manager', harness: 'hermes',
    mode: 'managed', workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false },
  { installed: new Set(['hermes']) });
  const listing = await definitions.list(), definition = listing.definitions[0];
  const request = id => ({ id, agentId: 'dashboard-manager', machineId: 'fixture-machine',
    storeId: listing.storeId, expectedIncarnation: definition.incarnation, expectedRevision: definition.revision,
    expectedLifetime: null, action: 'start', requestedBy: 'fixture' });
  let current = null, effects = 0;
  const journal = new LifecycleJournal({ file: path.join(home, 'agent-lifecycle.json') });
  const boot = (scope = null, nowMs = 1000) => bootDaemonAgentState({ aifyHome: home,
    context: scope === null ? null : { scope }, url: 'http://127.0.0.1:9999', pid: 9,
    nowMs, nowUs: () => nowMs * 1000, probe: () => new Map() });
  const ports = (buildSpec = async () => ({ command: 'injected-no-child' })) => createAgentLifecyclePorts({
    aifyHome: home, machineId: 'fixture-machine', definitions,
    stateHost: { rawIdentity: () => ({ current, unknown: false, conflict: false }) },
    buildSpec, installed: async () => new Set(['hermes']),
    runner: { start: () => { effects++; current = { lifetime: 'fixture-lifetime', handle: 'fixture-handle', pid: 123 }; } },
  });
  return { home, request, journal, boot, ports, effects: () => effects };
}

test('healthy boot and actual lifecycle ports admit a start through the same apparatus', async t => {
  const f = await fixture(t); f.boot();
  const answer = await f.ports().lifecycle.execute(f.request('healthy'));
  assert.deepEqual([answer.status, answer.outcome], ['done', 'start']);
  assert.equal(f.effects(), 1);
});

test('RED on 34c31d0: a reservation left by a previous boot must not block a new start forever', async t => {
  const f = await fixture(t); f.boot();
  const old = f.request('abandoned');
  const admission = f.journal.reserve(old);
  assert.equal(admission.fresh, true, 'the seed owns a genuine durable reservation');
  f.boot(null, 2000);
  const answer = await f.ports().lifecycle.execute(f.request('after-restart'));
  assert.deepEqual([answer.status, answer.outcome], ['done', 'start'],
    'a replacement boot currently returns refused/agent-reserved');
  assert.deepEqual(f.journal.reserve(old), { fresh: false, result: admission.unknown },
    'replaying the abandoned id must keep its original unknown receipt');
});

test('a second live daemon scope shares the journal but must preserve an in-flight reservation', async t => {
  const f = await fixture(t); f.boot('live-dedicated');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const active = f.ports(async () => { enter(); await gate; return { command: 'injected-no-child' }; })
    .lifecycle.execute(f.request('active-other-scope'));
  await entered;
  try {
    f.boot(null, 2000);
    assert.equal(f.journal.open().find(row => row.id === 'active-other-scope')?.phase, 'pending');
    assert.equal(f.journal.reserve(f.request('competing')).result.outcome, 'agent-reserved');
    assert.equal(f.effects(), 0);
  } finally { release(); await active; }
  assert.equal(f.effects(), 1);
});

test('a simulated blanket boot settlement releases another live scope before its operation returns', async t => {
  const f = await fixture(t); f.boot('live-dedicated');
  let enter, release, returned = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const request = f.request('still-active');
  const active = f.ports(async () => { enter(); await gate; return { command: 'injected-no-child' }; })
    .lifecycle.execute(request).finally(() => { returned = true; });
  await entered;
  try {
    f.boot(null, 2000);
    assert.equal(f.journal.reserve(f.request('before-simulated-settlement')).result.outcome, 'agent-reserved');
    const held = f.journal.open().find(row => row.id === request.id);
    assert.ok(held, 'the active operation really holds the slot');
    f.journal.finish(request, held.unknown);
    assert.equal(returned, false);
    assert.equal(f.journal.reserve(f.request('after-simulated-settlement')).fresh, true,
      'blanket settlement would admit competing custody while the original operation is still active');
  } finally { release(); await active; }
});
