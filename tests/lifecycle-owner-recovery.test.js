// Real boot/journal/definition/lifecycle composition; the runner creates no process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { bootDaemonAgentState } from '../lib/daemon-agent-state.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';

const prior = { scope: 'http://127.0.0.1:9999', generation: 1000, pid: 11, createdAtUs: 100 };
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'owned-reservation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'agent-lifecycle.json');
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  await definitions.set('dashboard-manager', { name: 'Fixture', role: 'manager', harness: 'hermes',
    mode: 'managed', workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false },
  { installed: new Set(['hermes']) });
  const listing = await definitions.list(), definition = listing.definitions[0];
  const request = id => ({ id, agentId: 'dashboard-manager', machineId: 'fixture-machine',
    storeId: listing.storeId, expectedIncarnation: definition.incarnation, expectedRevision: definition.revision,
    expectedLifetime: null, action: 'start', requestedBy: 'fixture' });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const boot = (patch = {}) => bootDaemonAgentState({ aifyHome: home, url: prior.scope, pid: 12,
    nowMs: 2000, nowUs: () => 2000000,
    probe: () => new Map([[11, { alive: false, createdAtUs: null }], [12, { alive: true, createdAtUs: 200 }]]), ...patch });
  boot({ nowMs: 1000, pid: 11 });
  const journal = new LifecycleJournal({ file });
  // A future-format saved row must be accepted by the unchanged base reader too. This is a wire fixture,
  // not a claim that the base writer already records ownership.
  const seed = (owner = prior) => {
    const admission = journal.reserve(request('abandoned'));
    const data = read();
    if (owner !== null) data.records.abandoned.owner = owner;
    fs.writeFileSync(file, JSON.stringify(data));
    return admission;
  };
  let current = null, effects = 0;
  const ports = (owner, buildSpec = async () => ({ command: 'injected-no-child' })) => createAgentLifecyclePorts({
    aifyHome: home, owner, machineId: 'fixture-machine', definitions,
    stateHost: { rawIdentity: () => ({ current, unknown: false, conflict: false }) }, buildSpec,
    installed: async () => new Set(['hermes']),
    runner: { start: () => { effects++; current = { lifetime: 'fixture-lifetime', handle: 'fixture-handle', pid: 123 }; } },
  });
  return { home, file, request, read, boot, journal, seed, ports, effects: () => effects };
}

test('new explicit and automatic reservations durably record their daemon owner', async t => {
  const f = await fixture(t), owner = { ...prior, pid: 12, generation: 2000, createdAtUs: 200 };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const active = f.ports(owner, async () => { enter(); await gate; return { command: 'injected-no-child' }; })
    .lifecycle.execute(f.request('explicit'));
  await entered;
  try { assert.deepEqual(f.read().records.explicit.owner, owner); }
  finally { release(); await active; }
  const g = await fixture(t);
  const launch = { agentId: 'dashboard-manager', runtime: 'hermes', definition: {
    storeId: g.request('x').storeId, incarnation: 1, revision: 1 } };
  await g.ports(owner).admitColdStart(launch, () => ({ unknown: true }), async () => true);
  const rows = Object.values(g.read().records);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].owner, owner);
});

test('a replacement settles a proven-dead prior-generation owner and admits the next start', async t => {
  const f = await fixture(t), admission = f.seed();
  const booted = f.boot();
  const answer = await f.ports(booted.lifecycleOwner).lifecycle.execute(f.request('after-restart'));
  assert.deepEqual([answer.status, answer.outcome], ['done', 'start']);
  assert.equal(f.effects(), 1);
  assert.equal(f.read().records.abandoned.phase, 'terminal');
  assert.deepEqual(f.read().records.abandoned.result, admission.unknown);
  assert.deepEqual(f.journal.reserve(f.request('abandoned')), { fresh: false, result: admission.unknown });
});

test('a live concurrent scope retains custody while another scope boots', async t => {
  const f = await fixture(t), owner = { ...prior, scope: 'herdr-live' };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const active = f.ports(owner, async () => { enter(); await gate; return { command: 'injected-no-child' }; })
    .lifecycle.execute(f.request('concurrent'));
  await entered;
  try {
    // Seed on the unchanged base, whose writer ignores the future owner option.
    const data = f.read(); data.records.concurrent.owner = owner; fs.writeFileSync(f.file, JSON.stringify(data));
    f.boot({ probe: () => new Map([[11, { alive: true, createdAtUs: 100 }], [12, { alive: true, createdAtUs: 200 }]]) });
    assert.equal(f.read().records.concurrent.phase, 'pending');
    assert.equal(f.journal.reserve(f.request('competing')).result.outcome, 'agent-reserved');
    assert.equal(f.effects(), 0);
  } finally { release(); await active; }
  assert.equal(f.effects(), 1);
});

for (const [name, reading, settles] of [
  ['gone pid', { alive: false, createdAtUs: null }, true],
  ['reused pid', { alive: true, createdAtUs: 101 }, true],
  ['live owner', { alive: true, createdAtUs: 100 }, false],
  ['unknown owner', { alive: null, createdAtUs: null }, false],
  ['missing birth time', { alive: true, createdAtUs: null }, false],
]) test(`nonexclusive prior owner: ${name}`, async t => {
  const f = await fixture(t), admission = f.seed({ ...prior, scope: 'herdr-previous' });
  const booted = f.boot({
    probe: () => new Map([[11, reading], [12, { alive: true, createdAtUs: 200 }]]) });
  const answer = await f.ports(booted.lifecycleOwner).lifecycle.execute(f.request('after-restart'));
  assert.deepEqual([answer.status, answer.outcome], settles ? ['done', 'start'] : ['refused', 'agent-reserved']);
  assert.equal(f.read().records.abandoned.phase, settles ? 'terminal' : 'pending');
  assert.equal(f.effects(), settles ? 1 : 0);
  if (settles) assert.deepEqual(f.read().records.abandoned.result, admission.unknown);
});

test('an ownerless legacy reservation stays reserved despite a replacement boot', async t => {
  const f = await fixture(t); f.seed(null);
  f.boot({ probe: () => new Map([[11, { alive: false }]]) });
  assert.equal(f.read().records.abandoned.phase, 'pending');
  assert.equal(f.journal.reserve(f.request('new')).result.outcome, 'agent-reserved');
});

test('different default ports are different recovery scopes even with an earlier generation', async t => {
  const f = await fixture(t); f.seed({ ...prior, scope: 'http://127.0.0.1:9998' });
  f.boot({ probe: () => new Map([[11, { alive: true, createdAtUs: 100 }]]) });
  assert.equal(f.read().records.abandoned.phase, 'pending');
});

test('recovery rereads ownership under the lock after its process probe', async t => {
  const f = await fixture(t); f.seed({ ...prior, scope: 'herdr-owned' });
  const replacement = { ...prior, scope: 'herdr-owned', createdAtUs: 101 };
  f.boot({ probe: () => {
    const data = f.read(); data.records.abandoned.owner = replacement;
    fs.writeFileSync(f.file, JSON.stringify(data));
    return new Map([[11, { alive: true, createdAtUs: 100 }], [12, { alive: true, createdAtUs: 200 }]]);
  } });
  assert.equal(f.read().records.abandoned.phase, 'pending');
  assert.deepEqual(f.read().records.abandoned.owner, replacement);
});

test('recovery preserves a result completed while the process probe was running', async t => {
  const f = await fixture(t); f.seed();
  const done = { status: 'done', outcome: 'start', resultLifetime: 'verified-lifetime',
    finishedAt: '2026-10-24T00:00:00.000Z' };
  f.boot({ probe: () => {
    f.journal.finish(f.request('abandoned'), done);
    return new Map([[11, { alive: false }], [12, { alive: true, createdAtUs: 200 }]]);
  } });
  assert.deepEqual(f.read().records.abandoned.result, done);
});
