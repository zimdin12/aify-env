import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCommsPlugin } from '../lib/plugins/aify-comms/index.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';

async function fixture(t, { defined = true, stopped = false, missing = '', incomplete = false, binding = true, competing = false, subscription = 'healthy', reportThrows = false, onReport = null } = {}) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'automatic-producer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions'), lockWaitMs: 100 });
  if (defined) await definitions.set('a', { id: 'a', name: 'Fixture', role: 'worker', harness: 'hermes', mode: 'managed', workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['hermes']) });
  const listed = await definitions.list();
  const row = listed.definitions[0];
  const launcher = path.join(home, 'wrapper');
  fs.writeFileSync(launcher, '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1"\n');
  const launch = { agentId: 'a', runtime: 'hermes', cwd: home, argv: [launcher, '--fixture'],
    ...(defined && binding ? { definition: { storeId: listed.storeId, incarnation: row.incarnation, revision: row.revision } } : {}) };
  fs.writeFileSync(path.join(home, 'agent-lifecycle.json'), JSON.stringify({ version: 1, records: {}, stops: {} }));
  const journal = new LifecycleJournal({ file: path.join(home, 'agent-lifecycle.json') });
  // An unrelated stop is retained even in the healthy control.
  const request = { id: 'operator', agentId: stopped ? 'a' : 'b', machineId: 'machine', storeId: listed.storeId,
    expectedIncarnation: row?.incarnation ?? 1, expectedRevision: row?.revision ?? 1, expectedLifetime: null, action: 'stop', requestedBy: 'fixture' };
  journal.reserve(request); journal.finish(request, { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-10-08T00:00:00.000Z' }, true);
  const before = [...journal.stopFacts()];
  const calls = { births: [], admissions: [], identities: [], lists: 0, reports: [], claims: 0, subscriptions: [], birthLocks: [], openAtSubscribe: [], continuationLocks: [] };
  const stateHost = new AgentStateHost({ aifyHome: home, instance: 'fixture', probe: () => new Map(), nowUs: () => 1700000000001000 });
  stateHost.boot();
  const processes = { list: () => [], start: async spec => {
    calls.births.push(spec); calls.birthLocks.push(fs.existsSync(path.join(home, 'definitions', '.lock')));
    stateHost.startManaged({ agentId: 'a', lifetime: '11111111-1111-4111-8111-111111111111',
      instance: 'fixture', harness: 'hermes', pid: 123, handle: 'fake-runner', launcher, writtenAtUs: Date.now() * 1000 });
    return { id: 'fake-runner', pid: 123 };
  }, subscribe: handle => {
    calls.subscriptions.push(handle); calls.openAtSubscribe.push(journal.open().length);
    calls.continuationLocks.push(fs.existsSync(path.join(home, 'definitions', '.lock')));
    if (subscription === 'throw') throw Error('subscription-lost');
    return subscription === 'missing' ? undefined : () => {};
  } };
  const rawIdentity = id => { calls.identities.push(id); return stateHost.rawIdentity(id); };
  const ports = createAgentLifecyclePorts({ aifyHome: home, machineId: 'machine', definitions, stateHost: { rawIdentity }, runner: processes, installed: async () => new Set(['hermes']) });
  const agents = { rawIdentity, admitColdStart: async (actual, produce, complete) => {
    calls.admissions.push(actual);
    if (competing) {
      // Deterministic ordering: automatic preflight is already complete; its final lock is not held.
      const explicit = { ...request, id: 'explicit-race', agentId: 'a', action: 'start' };
      calls.explicitResult = await ports.lifecycle.execute(explicit, {
        buildSpec: async () => ({ agentId: 'a', launcher, cwd: home }),
        start: async (prepared, runLocked) => runLocked(() => processes.start(prepared)),
      });
      calls.openAfterExplicit = journal.open(); calls.liveAfterExplicit = stateHost.rawIdentity('a');
    }
    return ports.admitColdStart(actual, produce, complete);
  } };
  if (missing) delete agents[missing];
  const list = definitions.list.bind(definitions);
  definitions.list = async () => { calls.lists++; const answer = await list(); return incomplete ? { ...answer, enumerationFailed: 'EACCES' } : answer; };
  const api = { heartbeat: async () => ({}), claim: async () => ({}),
    claimControls: async () => { calls.claims++; return { controls: [{ id: 'ordinary-control', terminalId: 't', action: 'start' }] }; },
    launch: async () => ({ launch }), reportControl: async (...args) => {
      calls.reports.push(args);
      if (args[1].status === 'completed') {
        if (onReport) await onReport({ journal, home, request, calls });
        if (reportThrows) throw Error('control-report-lost');
      }
      return {};
    },
    terminalOutput: async () => ({}), publishDefinitions: async () => ({}), claimDefinitionRequests: async () => ({ requests: [] }) };
  const plugin = createCommsPlugin({ api, agents, definitions, machineId: 'machine', windows: true, platform: 'linux',
    advertisement: () => ({ kind: 'test', hostname: 'host' }), cwdRoots: () => [home],
    installedHarnesses: async () => new Set(['hermes']), setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} });
  t.after(() => plugin.stop());
  await plugin.start({ processes, log: () => {} });
  // Wait for the real pass report, including filesystem lock contention with definition sync.
  for (let i = 0; i < 100 && !calls.reports.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.claims, 1, 'ordinary control producer entered');
  assert.equal(calls.reports.length, 1, 'control reached its terminal report');
  return { calls, launch, journal, before };
}

test('ordinary stopped-defined automatic control has zero birth through shared host admission', async t => {
  const f = await fixture(t, { stopped: true });
  assert.equal(f.calls.births.length, 0);
  assert.deepEqual(f.calls.admissions, [f.launch]);
  assert.equal(f.calls.reports[0][1].error, 'stopped-by-operator');
  assert.deepEqual([...f.journal.stopFacts()], f.before);
});

test('healthy defined automatic control engages the gate once with the exact supplied launch', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.births.length, 1, 'unrelated gates are open');
  assert.equal(f.calls.admissions.length, 1);
  assert.equal(f.calls.admissions[0], f.launch, 'no invented or cloned binding');
  assert.deepEqual(f.calls.identities, ['a', 'a', 'a', 'a'], 'preflight, locked cold, actual birth and acknowledged lifetime reads address the same agent');
  assert.ok(f.calls.lists > 0, 'classification uses the local definition reading');
  assert.equal(f.calls.reports[0][1].status, 'completed');
  assert.deepEqual([...f.journal.stopFacts()], f.before);
});

test('completed explicit start invalidates an earlier cold automatic preflight before a second birth', async t => {
  const f = await fixture(t, { competing: true });
  assert.equal(f.calls.explicitResult.status, 'done', 'actual canonical host executor completed');
  assert.deepEqual(f.calls.openAfterExplicit, [], 'explicit reservation already released');
  assert.equal(f.calls.liveAfterExplicit.current.lifetime, f.calls.explicitResult.resultLifetime);
  assert.deepEqual(f.calls.liveAfterExplicit, { current: f.calls.liveAfterExplicit.current, conflict: false, unknown: false });
  assert.equal(f.calls.births.length, 1, 'canonical live identity must prevent another attempted birth');
  assert.deepEqual(f.calls.birthLocks, [true]);
  assert.deepEqual(f.calls.subscriptions, [], 'automatic refusal does not attach to a second producer');
  assert.equal(f.calls.reports[0][1].status, 'failed');
  assert.equal(f.calls.reports[0][1].error, 'identity-moved');
  const records = Object.values(JSON.parse(fs.readFileSync(path.join(f.launch.cwd, 'agent-lifecycle.json'), 'utf8')).records);
  assert.equal(records.some(row => JSON.parse(row.intent)[8] === 'automatic'), false, 'no slot is acquired from stale identity');
  assert.deepEqual([...f.journal.stopFacts()], [...f.before, [`${f.launch.definition.storeId}:${f.launch.definition.incarnation}:a`, false]]);
});

test('known undefined automatic control preserves legacy birth without lifecycle admission', async t => {
  const f = await fixture(t, { defined: false });
  assert.equal(f.calls.births.length, 1);
  assert.deepEqual(f.calls.admissions, []);
  assert.ok(f.calls.lists > 0, 'undefined must be established by a complete reading');
  assert.equal(f.calls.reports[0][1].status, 'completed');
});

for (const missing of ['admitColdStart', 'rawIdentity']) test(`defined automatic control refuses missing ${missing}`, async t => {
  const f = await fixture(t, { missing });
  assert.equal(f.calls.births.length, 0);
  assert.equal(f.calls.reports[0][1].status, 'failed');
});

test('incomplete local reading cannot classify a launch as legacy undefined', async t => {
  const f = await fixture(t, { defined: false, incomplete: true });
  assert.equal(f.calls.births.length, 0);
  assert.equal(f.calls.reports[0][1].status, 'failed');
});

test('defined automatic control without supplied binding cannot fall back to legacy birth', async t => {
  const f = await fixture(t, { binding: false });
  assert.equal(f.calls.births.length, 0);
  assert.equal(f.calls.reports[0][1].status, 'failed');
});

test('real plugin subscription and control acknowledgement are inside the durable automatic reservation and outside birth lock', async t => {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { onReport: async ({ journal, home, request }) => {
    assert.equal(fs.existsSync(path.join(home, 'definitions', '.lock')), false);
    assert.equal(journal.open().length, 1);
    assert.equal(journal.reserve({ ...request, id: 'competing-operator', agentId: 'a' }).result.outcome, 'agent-reserved');
    entered(); await gate;
  } });
  try {
    // fixture reached the actual api report; inspect before releasing acknowledgement.
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(Error('continuation-not-held')), 100))]);
    assert.deepEqual(f.calls.openAtSubscribe, [1]);
    assert.deepEqual(f.calls.continuationLocks, [false]);
    assert.equal(f.journal.open().length, 1);
  } finally { release(); }
});

for (const subscription of ['missing', 'throw']) test(`real plugin ${subscription} subscription retains automatic unknown`, async t => {
  const f = await fixture(t, { subscription });
  assert.equal(f.calls.births.length, 1);
  assert.equal(f.journal.open().length, 1, 'actual birth has no verified output custody');
  assert.equal(f.calls.reports.some(args => args[1].status === 'completed'), false);
});

test('real plugin failed control acknowledgement retains automatic unknown', async t => {
  const f = await fixture(t, { reportThrows: true });
  assert.equal(f.calls.births.length, 1);
  // report() catches the transport failure. The caller must consume its false result.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.journal.open().length, 1);
  assert.equal(f.calls.reports.filter(args => args[1].status === 'completed').length, 1);
});

