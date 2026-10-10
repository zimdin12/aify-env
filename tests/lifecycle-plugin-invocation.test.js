import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { AgentLifecycle, LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { createCommsPlugin } from '../lib/plugins/aify-comms/index.mjs';
import { LifecycleLaunch } from '../lib/plugins/aify-comms/lifecycle-launch.mjs';

async function fixture(t, mode = 'healthy') {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'plugin-invocation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  const agent = { id: 'a', name: 'Fixture', role: 'worker', harness: 'hermes', mode: 'managed',
    workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false };
  await definitions.set('a', agent, { installed: new Set(['hermes']) });
  const listing = await definitions.list(), row = listing.definitions[0];
  const request = { id: 'r1', agentId: 'a', machineId: 'm', storeId: listing.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision,
    expectedLifetime: null, action: 'start', requestedBy: 'fixture' };
  const journal = new LifecycleJournal({ file: path.join(home, 'journal.json') });
  journal.initialize({ priorBoot: false });
  const stopped = { ...request, id: 'prior-stop', action: 'stop' };
  journal.reserve(stopped); journal.markStopped(stopped);
  journal.finish(stopped, { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: 'fixture' });
  const stopKey = `${request.storeId}:${request.expectedIncarnation}:a`;
  const stateHost = new AgentStateHost({ aifyHome: home, instance: 'owner', probe: () => new Map(), nowUs: () => 1700000000001000 });
  stateHost.boot();
  const lock = path.join(home, 'definitions', '.lock'), events = [];
  const launcher = path.join(home, 'wrapper');
  fs.writeFileSync(launcher, '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1"\n');
  const launch = { agentId: 'a', runtime: 'hermes', terminalId: 't', argv: [launcher, '--fixture'], cwd: home,
    definition: { storeId: request.storeId, incarnation: row.incarnation, revision: row.revision }, herdrSpace: false };
  const record = { agentId: 'a', lifetime: '11111111-1111-4111-8111-111111111111', instance: 'owner',
    harness: 'hermes', pid: 424242, handle: 'h', launcher, writtenAtUs: 1700000000001000 };
  let prepared, attachment, report, output, birthAttempts = 0, reports = 0, liveHandles = [];
  const timers = [];
  const originalPrepare = LifecycleLaunch.prototype.prepare, originalStart = LifecycleLaunch.prototype.start;
  LifecycleLaunch.prototype.prepare = async function (...args) {
    const answer = await originalPrepare.apply(this, args); prepared = answer;
    assert.equal(fs.existsSync(lock), false);
    if (mode === 'moved') await definitions.set('a', { ...agent, model: 'different' }, { installed: new Set(['hermes']) });
    return answer;
  };
  LifecycleLaunch.prototype.start = async function (environmentId, value, runLocked) {
    assert.equal(value, prepared, 'exact preparation object crosses the factory and sync');
    return originalStart.call(this, environmentId, value, mode === 'missing' ? undefined : runLocked);
  };
  t.after(() => { LifecycleLaunch.prototype.prepare = originalPrepare; LifecycleLaunch.prototype.start = originalStart; });
  const lifecycle = new AgentLifecycle({ journal, definitions, machineId: 'm', identity: id => stateHost.rawIdentity(id),
    installed: async () => new Set(['hermes']), buildSpec: () => { throw Error('default builder forbidden'); },
    start: () => { throw Error('default birth forbidden'); }, stop: () => { throw Error('stop forbidden'); } });
  const processes = { list: () => liveHandles,
    async start(spec) {
      birthAttempts++;
      assert.equal(fs.existsSync(lock), true, 'fake process birth is inside real DefinitionStore admission');
      assert.deepEqual(spec, { ...prepared.spec, agentId: 'a', id: 't', cols: 0, rows: 0, space: false });
      events.push('birth'); stateHost.startManaged(record); liveHandles = [{ id: 'h' }]; return { id: 'h', pid: 424242 };
    },
    subscribe(handle, onOutput) {
      assert.equal(fs.existsSync(lock), false, 'subscription follows lock release');
      assert.equal(handle, 'h'); events.push('subscription'); output = onOutput; return () => {};
    } };
  const api = { heartbeat: async () => ({}), claim: async () => ({}), claimControls: async () => ({ controls: [] }),
    claimLifecycleRequests: async () => ({ requests: [request] }),
    async prepareLifecycleLaunch() { assert.equal(fs.existsSync(lock), false); events.push('prepare'); return { ok: true, launch }; },
    async reportLifecycleAttachment(e, id, machine, body) {
      assert.equal(fs.existsSync(lock), false, 'attachment follows lock release');
      assert.equal(journal.open().length, 1, 'attachment precedes durable completion');
      assert.equal(journal.stopFacts().get(stopKey), true, 'attachment precedes stop clearing');
      assert.deepEqual(stateHost.rawIdentity('a'), { current: record, conflict: false, unknown: false });
      attachment = body; events.push('attachment'); return { ok: true, attachment: { ...body } };
    },
    async reportLifecycleRequest(e, id, machine, body) { report = body; reports++; events.push('report'); },
    async terminalOutput() { assert.equal(fs.existsSync(lock), false); events.push('output'); return {}; } };
  const plugin = createCommsPlugin({ api, definitions, agents: { lifecycle, rawIdentity: id => stateHost.rawIdentity(id) },
    machineId: 'm', installedHarnesses: async () => new Set(['hermes']),
    advertisement: () => ({ kind: 'test', hostname: 'fixture' }), cwdRoots: () => [home],
    platform: 'linux', windows: true,
    setTimeoutImpl: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeoutImpl: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); } });
  t.after(() => plugin.stop());
  await plugin.start({ processes, log: () => {} });
  for (let i = 0; i < 100 && !report; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(report, 'the real factory lifecycle pass reports');
  return { events, report, attachment, journal, stopKey, plugin, get birthAttempts() { return birthAttempts; },
    reports: () => reports, endWorker: () => { liveHandles = []; },
    tick: async () => { for (const timer of timers.splice(0)) timer.callback(); await new Promise(resolve => setImmediate(resolve)); },
    output: async () => { output('fixture-output'); await new Promise(resolve => setImmediate(resolve)); } };
}

test('factory lifecycle pass joins exact prepared launch to locked birth and unlocked attachment', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.events, ['prepare', 'birth', 'subscription', 'attachment', 'report']);
  assert.equal(f.report.status, 'done'); assert.equal(f.report.resultLifetime, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(f.attachment, { terminalId: 't', handle: 'h', processId: 424242, lifetime: f.report.resultLifetime });
  assert.equal(f.journal.open().length, 0); assert.equal(f.journal.stopFacts().get(f.stopKey), false);
  await f.output(); assert.equal(f.events.at(-1), 'output');
});

test('otherwise healthy factory launch without callable admission fails closed before birth', async t => {
  const f = await fixture(t, 'missing');
  assert.equal(f.birthAttempts, 0, 'count attempted calls before the lock assertion can mask them');
  assert.deepEqual(f.events, ['prepare', 'report']);
  assert.equal(f.report.outcome, 'execution-unknown');
  assert.equal(f.journal.stopFacts().get(f.stopKey), true);
});

test('factory launch preserves actual moved-definition diagnostic without subscription or attachment', async t => {
  const f = await fixture(t, 'moved');
  assert.deepEqual(f.events, ['prepare', 'report']);
  assert.equal(f.report.status, 'refused');
  assert.equal(f.report.outcome, 'a changed since this start was queued: revision 1 -> 2; start it again');
  assert.equal(f.journal.open().length, 0); assert.equal(f.journal.stopFacts().get(f.stopKey), true);
});

test('held factory stops lifecycle claims until resume, then replays without another birth', async t => {
  const f = await fixture(t);
  assert.equal(f.birthAttempts, 1); assert.equal(f.reports(), 1);
  assert.deepEqual(await f.plugin.detach(), { detached: false, held: 1 });
  await f.tick();
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reports(), 1, 'held phase does not claim lifecycle work');
  assert.equal(f.plugin.resume(), true);
  for (let i = 0; i < 100 && f.reports() < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reports(), 2); assert.equal(f.birthAttempts, 1);
  f.endWorker(); assert.deepEqual(await f.plugin.detach(), { detached: true, held: 0 });
});
