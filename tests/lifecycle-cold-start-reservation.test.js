import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'cold-reservation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  await definitions.set('a', { id: 'a', name: 'Fixture', role: 'worker', harness: 'hermes', mode: 'managed', workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['hermes']) });
  const listed = await definitions.list(); const row = listed.definitions[0];
  const launch = { agentId: 'a', runtime: 'hermes', definition: { storeId: listed.storeId, incarnation: row.incarnation, revision: row.revision } };
  const request = { id: 'operator', agentId: 'a', machineId: 'machine', storeId: listed.storeId, expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: null, action: 'stop', requestedBy: 'fixture' };
  const file = path.join(home, 'agent-lifecycle.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: {}, stops: {} }));
  const journal = new LifecycleJournal({ file });
  let current = null;
  const birth = () => { current = { agentId: 'a', handle: 'fake-runner', pid: 123, lifetime: 'fake-lifetime' }; return { id: 'fake-runner', pid: 123 }; };
  const ports = () => createAgentLifecyclePorts({ aifyHome: home, machineId: 'machine', definitions, stateHost: { rawIdentity: () => ({ current, unknown: false, conflict: false }) }, runner: {}, installed: async () => new Set(['hermes']) });
  return { home, definitions, launch, request, file, journal, ports, birth };
}

test('automatic success holds a durable slot through awaited production then releases it', async t => {
  const f = await fixture(t); let produced = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const pending = f.ports().admitColdStart(f.launch, async () => { produced++; entered(); await gate; return f.birth(); }, async () => true);
  await ready;
  try {
    const held = f.journal.open(); assert.equal(held.length, 1);
    assert.match(held[0].id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    const tuple = JSON.parse(held[0].intent);
    assert.equal(tuple[1], 'a'); assert.equal(tuple[3], f.launch.definition.storeId);
    assert.equal(tuple[4], f.launch.definition.incarnation); assert.equal(tuple[5], f.launch.definition.revision);
    assert.equal(fs.existsSync(path.join(f.home, 'definitions', '.lock')), true);
    const reserved = new LifecycleJournal({ file: f.file }).reserve(f.request);
    assert.equal(reserved.fresh, false); assert.equal(reserved.result.outcome, 'agent-reserved');
  } finally { release(); await pending; }
  assert.equal(produced, 1); assert.deepEqual(f.journal.open(), []);
  assert.equal(f.journal.stopFacts().size, 0);
});

test('automatic admission refuses durable pending, stopped, malformed, and stale-definition causes before effect', async t => {
  for (const cause of ['pending', 'stopped', 'malformed', 'scalarStops', 'scalarRecords', 'stale']) {
    await t.test(cause, async t => {
      const f = await fixture(t); let produced = 0;
      if (cause === 'pending') f.journal.reserve(f.request);
      if (cause === 'stopped') { f.journal.reserve(f.request); f.journal.finish(f.request, { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-10-08T00:00:00.000Z' }, true); }
      if (cause === 'malformed') fs.writeFileSync(f.file, '{"version":1,"records":{},"stops":"invalid"}');
      if (cause === 'scalarStops') fs.writeFileSync(f.file, '{"version":1,"records":{},"stops":true}');
      if (cause === 'scalarRecords') fs.writeFileSync(f.file, '{"version":1,"records":true,"stops":{}}');
      if (cause === 'stale') f.launch.definition.revision++;
      const attempt = () => f.ports().admitColdStart(f.launch, () => { produced++; return f.birth(); }, async () => true);
      if (cause === 'malformed' || cause.startsWith('scalar')) await assert.rejects(attempt, /lifecycle-journal-malformed/);
      else { const answer = await attempt(); assert.equal(typeof answer.refused, 'string'); if (cause !== 'stale') assert.equal(answer.refused, cause === 'pending' ? 'agent-reserved' : 'stopped-by-operator'); }
      assert.equal(produced, 0);
      if (cause === 'stopped') assert.equal([...f.journal.stopFacts().values()][0], true);
    });
  }
});

test('uncertain production remains durably reserved across fresh journals and ports', async t => {
  for (const cause of ['throw', 'unknown']) await t.test(cause, async t => {
    const f = await fixture(t); let effects = 0;
    const attempt = () => f.ports().admitColdStart(f.launch, async () => { effects++; if (cause === 'throw') throw Error('after-fake-effect'); return { unknown: true }; }, async () => true);
    if (cause === 'throw') await assert.rejects(attempt, /after-fake-effect/); else await attempt();
    assert.equal(effects, 1);
    const fresh = new LifecycleJournal({ file: f.file }); const open = fresh.open();
    assert.equal(open.length, 1); assert.equal(open[0].unknown.outcome, 'execution-unknown');
    assert.equal(fresh.reserve(f.request).result.outcome, 'agent-reserved');
    assert.equal((await f.ports().admitColdStart(f.launch, () => ++effects, async () => true)).refused, 'agent-reserved');
    assert.equal(effects, 1);
  });
});

test('known producer refusal releases automatic reservation without a stop fact', async t => {
  const f = await fixture(t); let produced = 0;
  assert.equal((await f.ports().admitColdStart(f.launch, async () => { produced++; return { refused: 'fake-refusal' }; }, async () => true)).refused, 'fake-refusal');
  assert.equal(produced, 1); assert.deepEqual(f.journal.open(), []); assert.equal(f.journal.stopFacts().size, 0);
  assert.equal(f.journal.reserve(f.request).fresh, true);
});

// These discriminate premature settlement and unknown normalized to success.
test('automatic reservation remains outside the birth lock until positive continuation acknowledgement', async t => {
  const f = await fixture(t); let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let continuationCalls = 0;
  const pending = f.ports().admitColdStart(f.launch, f.birth, async started => {
    continuationCalls++;
    assert.equal(started.id, 'fake-runner');
    assert.equal(fs.existsSync(path.join(f.home, 'definitions', '.lock')), false);
    assert.equal(f.journal.open().length, 1);
    assert.equal(f.journal.reserve(f.request).result.outcome, 'agent-reserved');
    entered(); await gate; return true;
  });
  const reached = await Promise.race([ready.then(() => true), pending.then(() => false)]);
  try { assert.equal(reached, true, 'actual host must enter the post-birth continuation'); }
  finally { release(); await pending; }
  assert.equal(continuationCalls, 1);
  assert.deepEqual(f.journal.open(), []);
  const rows = Object.values(JSON.parse(fs.readFileSync(f.file, 'utf8')).records);
  assert.equal(rows[0].result.resultLifetime, 'fake-lifetime');
});

for (const answer of [undefined, null, false, 0, '', {}, [], { refused: '' }, { unknown: false }, { id: 'fake-runner', pid: '123' }, { id: 'fake-runner', pid: 123 }, { refused: 'ambiguous', id: 'fake-runner', pid: 123 }]) {
  test(`unclassified automatic producer retains unknown for ${JSON.stringify(answer)}`, async t => {
    const f = await fixture(t); let continuationCalls = 0;
    await f.ports().admitColdStart(f.launch, () => answer, async () => { continuationCalls++; return true; });
    assert.equal(f.journal.open().length, 1, 'malformed or unproved birth cannot free its durable slot');
    assert.equal(continuationCalls, 0, 'unclassified birth cannot attach or report completion');
    assert.equal(f.journal.reserve(f.request).result.outcome, 'agent-reserved');
  });
}

for (const cause of ['false', 'undefined', 'throw']) test(`automatic continuation ${cause} retains durable unknown`, async t => {
  const f = await fixture(t); let calls = 0;
  const complete = async () => { calls++; if (cause === 'throw') throw Error('attachment-lost'); return cause === 'false' ? false : undefined; };
  try { await f.ports().admitColdStart(f.launch, f.birth, complete); } catch (error) { assert.match(error.message, /attachment-lost/); }
  assert.equal(calls, 1);
  assert.equal(f.journal.open().length, 1);
  assert.equal(f.journal.reserve(f.request).result.outcome, 'agent-reserved');
});

test('absent continuation capability refuses before automatic birth', async t => {
  const f = await fixture(t); let births = 0;
  const answer = await f.ports().admitColdStart(f.launch, () => { births++; return f.birth(); });
  assert.equal(answer.refused, 'lifecycle-continuation-unavailable');
  assert.equal(births, 0);
  assert.deepEqual(f.journal.open(), []);
});



test('automatic missing established journal refuses exact cause before birth without recreation', async t => {
  const f = await fixture(t); fs.unlinkSync(f.file); let births = 0;
  const answer = await f.ports().admitColdStart(f.launch, () => { births++; return f.birth(); }, async () => true);
  assert.deepEqual(answer, { refused: 'lifecycle journal missing' });
  assert.equal(births, 0);
  assert.equal(fs.existsSync(f.file), false);
});
