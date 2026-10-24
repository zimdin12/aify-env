import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { AgentTurnEvents } from '../lib/agent-turn-events.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { DaemonResidents } from '../lib/daemon-residents.mjs';
import { handleRequest } from '../lib/protocol.mjs';
import { RESIDENT_START_PRODUCERS, residentStartBinding, ResidentStarts } from '../lib/resident-starts.mjs';

const LIFETIME = '11111111-1111-4111-8111-111111111111';
const WRITTEN = 1790000000000000;
const PID = 4243;
const CLI = fileURLToPath(new URL('../bin/aify-env-agents.mjs', import.meta.url));

class StartupFixture {
  constructor(root, harness) {
    this.root = root;
    this.home = path.join(root, '.aify');
    this.harness = harness;
    this.known = true;
  }
  async initialize(t) {
    fs.mkdirSync(this.home);
    this.file = path.join(this.home, 'agent-lifecycle.json');
    this.journal = new LifecycleJournal({ file: this.file });
    this.journal.initialize({ priorBoot: false });
    this.definitions = new DefinitionStore({ dir: path.join(this.home, 'agent-definitions') });
    this.agent = { name: 'Fixture', role: 'worker', harness: this.harness, mode: 'resident',
      workspace: this.root, model: '', effort: '', instructions: '', env: {}, herdrSpace: false };
    await this.definitions.set('fixture', this.agent, { installed: new Set([this.harness]) });
    const listing = await this.definitions.list(), row = listing.definitions[0];
    this.request = { id: 'stop-before', agentId: 'fixture', machineId: 'machine', storeId: listing.storeId,
      expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: null,
      action: 'stop', requestedBy: 'operator' };
    this.key = `${listing.storeId}:${row.incarnation}:fixture`;
    const probe = pids => new Map(pids.map(pid => [pid, this.known
      ? { alive: true, createdAtUs: WRITTEN - 1, commandLine: `bash "${process.execPath}"` }
      : { alive: null, createdAtUs: null, commandLine: null }]));
    this.managed = new AgentStateHost({ aifyHome: this.home, instance: 'managed', population: 'managed',
      probe, nowUs: () => WRITTEN + 1000 });
    this.managed.boot();
    this.residents = new DaemonResidents({ aifyHome: this.home, url: 'http://127.0.0.1:1',
      pid: process.pid, probe, nowUs: () => WRITTEN + 1000 });
    t.after(() => this.residents.release({ waitMs: 0 }));
    assert.equal(await this.residents.acquire(), true);
    this.ports = createAgentLifecyclePorts({ aifyHome: this.home, machineId: 'machine',
      stateHost: this.managed, residents: this.residents, definitions: this.definitions,
      installed: async () => new Set([this.harness]), runner: {
        start() { throw Error('runtime start forbidden'); }, stop() { throw Error('runtime stop forbidden'); },
      }, killTree: async () => { throw Error('process kill forbidden'); } });
    assert.equal((await this.ports.lifecycle.execute(this.request)).status, 'done');
    assert.equal(this.stopped(), true);
  }
  stopped() { return new LifecycleJournal({ file: this.file }).stopFacts().get(this.key); }
  captureResult() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('AIFY_') && !key.startsWith('HERDR_') && !key.endsWith('_SESSION_ID')));
    Object.assign(env, { HOME: this.root, USERPROFILE: this.root, HERMES_HOME: path.join(this.root, '.hermes'),
      APPDATA: path.join(this.root, 'AppData/Roaming'), LOCALAPPDATA: path.join(this.root, 'AppData/Local'),
      TEMP: this.root, TMP: this.root, TMPDIR: this.root,
      AIFY_AGENT_DEFINITIONS_DIR: path.join(this.home, 'agent-definitions') });
    return spawnSync(process.execPath, [CLI, 'resident-start-binding', 'fixture', this.harness, 'SessionStart'],
      { env, encoding: 'utf8', timeout: 15000 });
  }
  capture() {
    const answer = this.captureResult();
    assert.equal(answer.status, 0, `native binding CLI refused: ${answer.stderr}`);
    this.binding = JSON.parse(answer.stdout);
    return this.binding;
  }
  record(operatorStart = this.binding) {
    const dir = path.join(this.home, 'residents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `fixture.${LIFETIME}.json`), JSON.stringify({ agentId: 'fixture',
      lifetime: LIFETIME, instance: 'residents', harness: this.harness, pid: PID,
      launcher: process.execPath, writtenAtUs: WRITTEN, ...(operatorStart ? { operatorStart } : {}) }));
    this.residents.refresh();
  }
  body() { return { instance: 'residents', lifetime: LIFETIME, harness: this.harness,
    producer: 'SessionStart', sessionId: 'native-session' }; }
  async acknowledge(body = this.body()) {
    return handleRequest({ method: 'POST', path: '/agents/fixture/resident-started', body }, { lifecycle: this.ports });
  }
  assertRefusal(before, answer, reason) {
    assert.deepEqual({ consumed: answer.body.consumed, reason: answer.body.reason,
      journal: fs.readFileSync(this.file, 'utf8') }, { consumed: false, reason, journal: before });
  }
}
async function fixture(t, harness = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = new StartupFixture(root, harness);
  await result.initialize(t);
  return result;
}

test('native CLI captures a current definition and atomic stop snapshot without reserving or clearing', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.file, 'utf8');
  const stamp = f.capture();
  // Direct binding checks complement the existing CLI and host-route cases without another guard matrix.
  assert.deepEqual(RESIDENT_START_PRODUCERS, { claude: 'SessionStart' });
  assert.deepEqual(residentStartBinding({ ...stamp, unrelated: 'discarded' }), stamp);
  assert.equal(residentStartBinding({ ...stamp, producer: 'turn-end' }), null);
  assert.deepEqual({ ...stamp, stopReceipt: 'digest' }, { agentId: 'fixture', intent: 'replace', harness: 'claude',
    producer: 'SessionStart', storeId: f.request.storeId, incarnation: 1, revision: 1,
    stopRevision: 1, stopReceipt: 'digest' });
  assert.match(stamp.stopReceipt, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.journal.open(), []);
});

test('a bound native SessionStart clears once through the real host route and durable journal', async t => {
  const f = await fixture(t); f.capture(); f.record();
  assert.equal(f.ports.rawIdentity('fixture').current.lifetime, LIFETIME);
  const answer = await f.acknowledge();
  assert.equal(answer.status, 200); assert.equal(answer.body.consumed, true);
  assert.equal(f.stopped(), false);
  const before = fs.readFileSync(f.file, 'utf8');
  const replay = await f.acknowledge();
  f.assertRefusal(before, replay, 'stop-moved');
});

test('a later cold Stop before record publication wins over the old startup binding', async t => {
  const f = await fixture(t); f.capture();
  assert.equal((await f.ports.lifecycle.execute({ ...f.request, id: 'stop-later' })).status, 'done');
  f.record();
  const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'stop-moved');
  assert.equal(f.stopped(), true);
});

test('a moved definition cannot use its predecessor startup binding', async t => {
  const f = await fixture(t); f.capture();
  await f.definitions.set('fixture', { ...f.agent, model: 'changed' }, { installed: new Set(['claude']) });
  f.record();
  const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'definition-moved');
});

for (const moved of ['store', 'incarnation']) test(`a moved ${moved} cannot consume its predecessor startup binding`, async t => {
  const f = await fixture(t); const captured = f.capture();
  if (moved === 'store') {
    fs.renameSync(path.join(f.home, 'agent-definitions'), path.join(f.home, 'previous-agent-definitions'));
  } else await f.definitions.remove('fixture');
  await f.definitions.set('fixture', f.agent, { installed: new Set(['claude']) });
  const listing = await f.definitions.list(), row = listing.definitions[0];
  assert.equal(row.revision, captured.revision, 'revision equality isolates the moved identity field');
  if (moved === 'store') assert.notEqual(listing.storeId, captured.storeId);
  else assert.notEqual(row.incarnation, captured.incarnation);
  f.record();
  const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'definition-moved');
});

test('a callback for another lifetime cannot clear the current resident stop', async t => {
  const f = await fixture(t); f.capture(); f.record();
  const before = fs.readFileSync(f.file, 'utf8');
  const answer = await f.acknowledge({ ...f.body(), lifetime: '22222222-2222-4222-8222-222222222222' });
  f.assertRefusal(before, answer, 'identity-unresolved');
});

test('simultaneous managed and resident lifetimes cannot authorize a startup clear', async t => {
  const f = await fixture(t); f.capture(); f.record();
  f.managed.startManaged({ agentId: 'fixture', instance: 'managed', harness: 'claude',
    lifetime: '22222222-2222-4222-8222-222222222222', pid: PID + 1, launcher: process.execPath, writtenAtUs: WRITTEN });
  assert.equal(f.ports.rawIdentity('fixture').conflict, true);
  const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'identity-unresolved');
});

test('a startup acknowledgment whose role is lost while waiting for the definition lock cannot clear', async t => {
  const f = await fixture(t); f.capture(); f.record();
  const locked = f.definitions.withLifecycleDefinition.bind(f.definitions);
  f.definitions.withLifecycleDefinition = async work => { await f.residents.release({ waitMs: 0 }); return locked(work); };
  const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'not-owner');
});

test('UNKNOWN launcher identity cannot consume a native startup acknowledgment', async t => {
  const f = await fixture(t); f.capture(); f.record(); f.known = false;
  const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'identity-unresolved');
});

for (const [name, change] of [['legacy', () => null], ['start intent', stamp => ({ ...stamp, intent: 'start' })]]) {
  test(`${name} resident record never clears from a startup callback`, async t => {
    const f = await fixture(t); f.capture(); f.record(change(f.binding));
    const before = fs.readFileSync(f.file, 'utf8'), answer = await f.acknowledge();
    f.assertRefusal(before, answer, 'startup-binding-unavailable');
    assert.equal(f.stopped(), true);
  });
}
for (const [name, harness] of [['object', { toString: null }], ['array', ['claude']]]) {
  test(`invalid startup harness ${name} is dropped without damaging the valid process record`, async t => {
    const f = await fixture(t); f.capture();
    assert.doesNotThrow(() => f.record({ ...f.binding, harness }));
    const current = f.ports.rawIdentity('fixture').current;
    assert.equal(current.lifetime, LIFETIME);
    assert.equal(current.operatorStart, undefined);
    const before = fs.readFileSync(f.file, 'utf8');
    f.assertRefusal(before, await f.acknowledge(), 'startup-binding-unavailable');
  });
}

for (const harness of ['hermes', 'codex']) test(`${harness} is not a supported startup producer in this stage`, async t => {
  const f = await fixture(t, harness);
  assert.equal(f.captureResult().status, 65);
  f.record(null);
  const before = fs.readFileSync(f.file, 'utf8');
  const answer = await f.acknowledge();
  f.assertRefusal(before, answer, 'startup-producer-unavailable');
  assert.equal(f.stopped(), true);
});

test('an applied ordinary turn-end is not native startup proof and leaves the stop set', async t => {
  const f = await fixture(t); f.capture(); f.record();
  const events = new AgentTurnEvents({ host: f.managed, instance: 'managed', residents: f.residents });
  const end = events.receive('fixture', { instance: 'residents', lifetime: LIFETIME, kind: 'turn-end', firedAtUs: WRITTEN + 1000 });
  assert.equal(end.status, 200); assert.equal(end.body.applied, true);
  assert.equal(f.stopped(), true);
});

test('the binding CLI refuses an absent journal rather than initializing authority', async t => {
  const f = await fixture(t); fs.unlinkSync(f.file);
  assert.equal(f.captureResult().status, 65);
  assert.equal(fs.existsSync(f.file), false);
});

test('direct ResidentStarts capture and consume preserve then clear the durable stop once', async t => {
  const f = await fixture(t);
  const starts = new ResidentStarts({ definitions: f.definitions, journal: f.journal,
    residents: f.residents, identity: id => f.ports.rawIdentity(id) });
  const before = fs.readFileSync(f.file, 'utf8');
  const binding = await starts.capture('fixture', 'claude', 'SessionStart');
  assert.equal(binding.agentId, 'fixture');
  assert.equal(binding.stopRevision, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  f.record(binding);
  assert.deepEqual(await starts.consume('fixture', f.body()), { status: 200,
    body: { agentId: 'fixture', consumed: true, reason: 'resident-start' } });
  assert.equal(f.stopped(), false);
  const consumed = fs.readFileSync(f.file, 'utf8');
  f.assertRefusal(consumed, await starts.consume('fixture', f.body()), 'stop-moved');
});
