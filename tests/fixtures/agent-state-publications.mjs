// Capture serialized HTTP bodies, never construct publication rows. Only input adapters are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStateHost } from '../../lib/agent-state-host.mjs';
import { AgentStateSender } from '../../lib/agent-state-sender.mjs';
import { CREDENTIAL_ABSENT } from '../../lib/credential-store.mjs';

const BASE_MS = 1_793_491_200_000;
const token = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const definition = (id, mode = 'managed') => ({ id, incarnation: 1, problems: [],
  agent: { name: `Fixture ${id}`, role: 'coder', mode, harness: 'codex', workspace: 'C:/fixture/work' } });

class PublicationCapture {
  constructor(instance, population = 'managed', identity = {}) {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'state-schema-'));
    this.now = BASE_MS; this.fault = ''; this.roots = []; this.screen = null;
    this.definitions = [definition('alpha'), definition('beta'), definition('quiet'), definition('guest', 'resident'),
      { id: 'invalid', incarnation: 1, problems: ['fixture-invalid'] }];
    this.stopped = new Set(['quiet']); this.posts = []; this.label = '';
    this.answer = { alive: null, createdAtUs: null, commandLine: null };
    this.host = new AgentStateHost({ aifyHome: this.home, instance, population, nowUs: () => this.now * 1000,
      probe: pids => {
        assert.equal(population, 'all', 'managed capture must never probe a PID');
        return new Map(pids.map(pid => [pid, this.answer]));
      } });
    this.host.boot();
    this.instance = instance;
    this.sender = new AgentStateSender({ identity: { machineId: 'fixture:host', instance, generation: 7,
      incarnationId: token(900), build: 'fixture-build', ...identity }, stateHost: this.host,
      definitions: { list: () => {
        if (this.fault === 'definitions') throw Error('fixture definition failure');
        return { storeId: 'fixture-store', definitions: this.definitions };
      } },
      observedHarnesses: () => { if (this.fault === 'launchers') throw Error('fixture launcher failure'); return new Set(['codex']); },
      lifecycle: { stopFacts: () => {
        if (this.fault === 'stops') throw Error('fixture stop failure');
        return new Map([...this.stopped].map(id => [`fixture-store:1:${id}`, true]));
      } }, cwdRoots: () => this.roots,
      screens: () => [() => { if (this.fault === 'screens') throw Error('fixture screen failure'); return this.screen ? [this.screen] : []; }],
      readRegistry: () => JSON.stringify({ services: { fixture: { endpoint: 'http://fixture.invalid', agentState: { path: '/state' } } } }),
      credential: () => ({ state: CREDENTIAL_ABSENT }), nowMs: () => this.now,
      setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {},
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://fixture.invalid/state'); assert.equal(options.method, 'POST');
        this.posts.push({ name: this.label, body: JSON.parse(options.body) });
        return new Response(null, { status: 204 });
      } });
  }
  start(n) {
    this.host.startManaged({ agentId: 'alpha', lifetime: token(n), instance: this.instance, pid: 4100 + n,
      handle: `fixture-handle-${n}`, cwd: 'C:/fixture/work',
      definition: { storeId: 'fixture-store', incarnation: 1, revision: 1 } });
  }
  turn(kind, lifetime = token(1), futureUs = 0) {
    this.now += 1;
    const result = this.host.applyEvent({ agentId: 'alpha', lifetime, kind, firedAtUs: this.now * 1000 + futureUs });
    assert.equal(result.applied, true, `${kind}: ${result.reason}`);
  }
  async capture(name) {
    this.label = `${this.instance}/${name}`;
    const before = this.posts.length;
    await this.sender.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(this.posts.length, before + 1, `${this.label} must reach the injected transport once`);
  }
  async retire() {
    this.label = `${this.instance}/retired`;
    const result = await this.sender.retire();
    assert.equal(result.outcome, 'confirmed');
  }
  close() { this.sender.stop(); fs.rmSync(this.home, { recursive: true, force: true }); }
}

/** Real host -> reader -> publisher -> sender serialization; no daemon, child process or network. */
export async function captureAgentStatePublications() {
  const fixtures = [];
  const f = new PublicationCapture('managed');
  try {
    await f.capture('cold');
    f.start(1); await f.capture('idle');
    f.turn('turn-start'); await f.capture('working');
    f.turn('blocked'); await f.capture('blocked');
    f.turn('unblocked'); await f.capture('unblocked');
    f.turn('turn-end'); await f.capture('closed-turn');
    f.screen = { handle: 'fixture-handle-1', state: 'shell', rule: 'fixture-shell' }; await f.capture('shell');
    f.screen = { handle: 'fixture-handle-1', state: 'working', rule: 'fixture-working' }; await f.capture('screen-working');
    f.screen = { handle: 'fixture-handle-1', state: 'blocked', rule: 'folder-trust' }; await f.capture('screen-rule');
    f.fault = 'screens'; await f.capture('screen-unavailable'); f.fault = '';
    f.screen = null; f.roots = ['C:/fixture/other']; await f.capture('outside-roots'); f.roots = [];
    for (const fault of ['stops', 'definitions', 'launchers']) { f.fault = fault; await f.capture(`unavailable-${fault}`); }
    f.fault = ''; f.now += 60_000; await f.capture('periodic-snapshot');
    f.turn('turn-start', token(1), 1_000_000); await f.capture('future-turn-age');
    f.host.endManaged(token(1)); f.start(2); await f.capture('replacement');
    f.host.endManaged(token(2)); await f.capture('ended');
    f.definitions = f.definitions.filter(row => row.id !== 'alpha'); await f.capture('cold-row-withdrawal');
    f.definitions = []; await f.capture('empty-snapshot');
    await f.retire(); fixtures.push(...f.posts);
  } finally { f.close(); }
  const resident = new PublicationCapture('residents', 'all');
  try {
    resident.definitions = [];
    const record = { agentId: 'resident', lifetime: token(3), instance: 'residents', harness: 'codex', pid: 4103,
      launcher: 'C:/fixture/codex-aify', writtenAtUs: BASE_MS * 1000 - 1000 };
    fs.mkdirSync(path.join(resident.home, 'residents'));
    fs.writeFileSync(path.join(resident.home, 'residents', `resident.${token(3)}.json`), JSON.stringify(record));
    await resident.capture('identity-unknown');
    resident.answer = { alive: true, createdAtUs: record.writtenAtUs - 1000, commandLine: 'bash C:/fixture/codex-aify' };
    await resident.capture('turn-unknown');
    resident.now += 1;
    assert.equal(resident.host.applyEvent({ agentId: 'resident', lifetime: token(3), kind: 'turn-start', firedAtUs: resident.now * 1000 }).applied, true);
    await resident.capture('working');
    resident.now += 1;
    assert.equal(resident.host.applyEvent({ agentId: 'resident', lifetime: token(3), kind: 'turn-end', firedAtUs: resident.now * 1000 }).applied, true);
    await resident.capture('closed-turn'); fixtures.push(...resident.posts);
  } finally { resident.close(); }
  const metadata = new PublicationCapture('metadata', 'managed', { build: 'invalid build', reportEveryMs: 500 });
  try { await metadata.capture('omitted-invalid-metadata'); fixtures.push(...metadata.posts); }
  finally { metadata.close(); }
  return fixtures;
}
