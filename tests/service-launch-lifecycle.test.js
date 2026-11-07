// The lifecycle must classify the new proven-no-spawn failure, not broaden its generic unknown policy.
// Private stores and fake terminals only; safe for isolated decision mutants with the syscall tripwire.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { Runner } from '../lib/runner.mjs';
import { OwnedProcessRecord } from '../lib/owned-process-record.mjs';
import { SuccessorRecovery } from '../lib/successor-recovery.mjs';
import { StartAdmissionRefusal, RecoveryPending } from '../lib/start-admission-refusal.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();
const ALLOWED = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1.0"\n';
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const outcome = promise => promise.then(value => ({ value, error: null }), error => ({ value: null, error }));
class LifecycleFixture {
  roots = ['C:/work']; current = null; spawns = []; killed = 0;
  constructor(t) {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'service-roots-lifecycle-'));
    t.after(() => fs.rmSync(this.home, { recursive: true, force: true }));
    this.journal = path.join(this.home, 'agent-lifecycle.json');
    fs.writeFileSync(this.journal, JSON.stringify({ version: 1, records: {}, stops: {} }));
    this.definitions = new DefinitionStore({ dir: path.join(this.home, 'definitions') });
    const host = { startManaged: record => { this.current = record; }, endManaged: () => { this.current = null; return {}; } };
    this.runner = new Runner({ platform: 'win32', loadCheckpoint: null, startGate: () => this.gate?.(),
      managedHost: () => ({ host, instance: 'fixture', url: 'http://127.0.0.1:18802' }), isAlive: () => this.current !== null, killTree: async () => {},
      openTerminal: (command, args, options) => {
        if (this.openFailure) throw this.openFailure;
        this.spawns.push({ command, args, options }); let exited;
        return { pid: 424242, cols: 80, rows: 24, onData() {}, onExit(fn) { exited = fn; }, write() {}, resize() {},
          kill: () => { this.killed++; exited?.({ exitCode: 0 }); } };
      } });
    this.agent = { id: 'fixture-agent', name: 'Fixture', role: 'worker', harness: 'hermes', mode: 'managed', workspace: 'C:/work/project', model: '', effort: '', instructions: '', env: {}, herdrSpace: false };
  }
  spec(cwd = this.agent.workspace) { return { service: 'fixture', fileText: ALLOWED, command: 'fixture-worker', args: [], env: {}, cwd }; }
  ports(buildSpec = async agent => this.spec(agent.workspace)) {
    return createAgentLifecyclePorts({ aifyHome: this.home, machineId: 'fixture-machine', definitions: this.definitions,
      runner: this.runner, stateHost: { rawIdentity: () => ({ current: this.current, conflict: false, unknown: false }), endManaged() {} },
      installed: async () => new Set(['hermes']), buildSpec, cwdRoots: () => this.roots, windows: true, currentCwd: () => 'C:/work/default',
      isAlive: () => this.current !== null, settleMs: 0 });
  }
  async seed() { await this.definitions.set(this.agent.id, this.agent, { installed: new Set(['hermes']) }); }
  async request(action = 'start') {
    const list = await this.definitions.list(), row = list.definitions[0];
    return { id: 'request', agentId: this.agent.id, machineId: 'fixture-machine', storeId: list.storeId,
      expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: this.current?.lifetime ?? null,
      action, requestedBy: 'fixture' };
  }
  launch(request) { return { agentId: this.agent.id, runtime: 'hermes', definition: { storeId: request.storeId, incarnation: request.expectedIncarnation, revision: request.expectedRevision } }; }
  record() { return Object.values(JSON.parse(fs.readFileSync(this.journal, 'utf8')).records)[0]; }
}

async function heldRecovery(f) {
  const identity = { probe: async pids => new Map(pids.map(pid => [pid, { alive: true, createdAtUs: 1700000000000000 }])) };
  const recovery = new SuccessorRecovery({ platform: 'win32', selfPid: 424242, parentPid: 424241,
    record: new OwnedProcessRecord(path.join(f.home, 'owned-fixture.json'), { report: () => {} }), identity, report: () => {},
    termination: { incumbent: async () => ({ state: 'unknown', problem: 'original remains live' }) } });
  await recovery.supersede({ pid: 443000 });
  assert.equal((await recovery.recover()).ready, false);
  f.gate = () => recovery.admitStart();
}

// #17 adds a second trusted no-spawn type; #15's old cases cannot prove this new producer reaches each catch.
for (const lane of ['direct', 'invoked', 'automatic']) {
  test(`${lane} lifecycle classifies an actual ownership-recovery gate as a terminal no-spawn refusal`, async t => {
    const f = new LifecycleFixture(t); await f.seed(); await heldRecovery(f);
    const ports = f.ports(), request = await f.request();
    const processes = new PluginProcesses(f.runner, { cwdRoots: () => f.roots, windows: true });
    if (lane === 'automatic') {
      const launch = f.launch(request);
      const result = await outcome(ports.admitColdStart(launch, () => processes.start({ ...f.spec(), agentId: launch.agentId, definition: launch.definition }), async () => true));
      assert.equal(result.error, null, 'the actual typed recovery refusal is a known answer');
      assert.match(result.value?.refused ?? '', /ownership recovery is incomplete/);
    } else {
      const invocation = lane === 'invoked' ? { buildSpec: async () => f.spec(), start: (prepared, locked) => locked(() => processes.start(prepared)) } : null;
      const result = invocation ? await ports.lifecycle.execute(request, invocation) : await ports.lifecycle.execute(request);
      assert.equal(result.status, 'refused');
      assert.match(result.outcome, /ownership recovery is incomplete/);
    }
    assert.deepEqual({ starts: f.spawns.length, phase: f.record().phase }, { starts: 0, phase: 'terminal' });
    assert.ok(new RecoveryPending('fixture') instanceof StartAdmissionRefusal);
  });
}

test('a counterfeit ownership-recovery code stays execution-unknown', async t => {
  const f = new LifecycleFixture(t); await f.seed();
  f.gate = () => { throw Object.assign(Error('ownership recovery is incomplete'), { code: 'OWNERSHIP_RECOVERY_PENDING' }); };
  const answer = await f.ports().lifecycle.execute(await f.request());
  assert.deepEqual({ status: answer.status, outcome: answer.outcome, phase: f.record().phase, starts: f.spawns.length },
    { status: 'failed', outcome: 'execution-unknown', phase: 'pending', starts: 0 });
});

test('core lifecycle outside roots is a terminal typed refusal and starts nothing', async t => {
  const f = new LifecycleFixture(t); await f.seed(); f.roots = [];
  const ports = f.ports(), answer = await ports.lifecycle.execute(await f.request());
  assert.deepEqual({ status: answer.status, starts: f.spawns.length, phase: f.record().phase }, { status: 'refused', starts: 0, phase: 'terminal' });
  assert.match(answer.outcome, /outside this host's launch roots/); assert.equal(ports.stopFacts().size, 0);
});
test('core lifecycle healthy control starts through the same host policy', async t => {
  const f = new LifecycleFixture(t); await f.seed();
  const answer = await f.ports().lifecycle.execute(await f.request());
  assert.equal(answer.status, 'done'); assert.equal(f.spawns.length, 1); assert.equal(f.current.cwd, 'C:/work/project');
});
test('core lifecycle rereads roots after a waiting launch builder', async t => {
  const f = new LifecycleFixture(t); await f.seed(); const entered = defer(), held = defer();
  const ports = f.ports(async agent => { entered.resolve(); await held.promise; return f.spec(agent.workspace); });
  const pending = ports.lifecycle.execute(await f.request()); await entered.promise; f.roots = []; held.resolve();
  const answer = await pending;
  assert.deepEqual({ status: answer.status, starts: f.spawns.length }, { status: 'refused', starts: 0 });
});
test('invoked lifecycle keeps a typed plugin no-spawn failure as a known refusal', async t => {
  const f = new LifecycleFixture(t); await f.seed(); f.roots = [];
  const processes = new PluginProcesses(f.runner, { cwdRoots: () => f.roots, windows: true });
  const answer = await f.ports().lifecycle.execute(await f.request(), {
    buildSpec: async () => f.spec(), start: (prepared, runLocked) => runLocked(() => processes.start(prepared)),
  });
  assert.deepEqual({ status: answer.status, starts: f.spawns.length, phase: f.record().phase }, { status: 'refused', starts: 0, phase: 'terminal' });
  assert.match(answer.outcome, /outside this host's launch roots/);
});
test('automatic cold admission settles a typed no-spawn failure only while identity remains cold', async t => {
  const f = new LifecycleFixture(t); await f.seed(); f.roots = [];
  const request = await f.request(), launch = f.launch(request), ports = f.ports(); let completed = 0;
  const processes = new PluginProcesses(f.runner, { cwdRoots: () => f.roots, windows: true });
  const answer = await outcome(ports.admitColdStart(launch, () => processes.start({ ...f.spec(), agentId: launch.agentId, definition: launch.definition }), async () => { completed++; return true; }));
  assert.equal(answer.error === null, true, 'a proven policy refusal is an answer, not an unclassified throw');
  assert.match(answer.value?.refused ?? '', /outside this host's launch roots/);
  assert.deepEqual({ starts: f.spawns.length, completed, phase: f.record().phase, status: f.record().result?.status }, { starts: 0, completed: 0, phase: 'terminal', status: 'refused' });
});
test('automatic admission does not classify a counterfeit policy code as a known refusal', async t => {
  const f = new LifecycleFixture(t); await f.seed(); const request = await f.request(); let completed = 0;
  const cause = Object.assign(Error('outside this host\'s launch roots'), { code: 'LAUNCH_ROOTS_REFUSED' });
  const answer = await outcome(f.ports().admitColdStart(f.launch(request), async () => { throw cause; }, async () => { completed++; return true; }));
  assert.equal(answer.error === cause, true, 'the generic producer error is still an unclassified throw');
  assert.deepEqual({ phase: f.record().phase, completed, starts: f.spawns.length }, { phase: 'pending', completed: 0, starts: 0 });
});

test('a code or message that resembles policy refusal remains execution-unknown', async t => {
  const f = new LifecycleFixture(t); await f.seed(); f.openFailure = Object.assign(Error('outside this host\'s launch roots'), { code: 'LAUNCH_ROOTS_REFUSED' });
  const answer = await f.ports().lifecycle.execute(await f.request());
  assert.deepEqual({ status: answer.status, outcome: answer.outcome, phase: f.record().phase }, { status: 'failed', outcome: 'execution-unknown', phase: 'pending' });
});
test('a restart denied by roots still says its previous process was stopped', async t => {
  const f = new LifecycleFixture(t); await f.seed(); const first = await f.request(), launch = f.launch(first);
  await f.runner.start({ ...f.spec(), agentId: launch.agentId, definition: launch.definition });
  const request = await f.request('restart'); f.roots = [];
  const ports = f.ports(), answer = await ports.lifecycle.execute(request);
  assert.deepEqual({ status: answer.status, kills: f.killed, births: f.spawns.length, current: f.current }, { status: 'refused', kills: 1, births: 1, current: null });
  assert.match(answer.outcome, /^stopped; not restarted: .*outside this host's launch roots/);
  assert.equal([...ports.stopFacts().values()][0], true, 'the successful prior stop is not erased by launch refusal');
});
