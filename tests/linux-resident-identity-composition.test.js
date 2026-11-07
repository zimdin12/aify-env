// Contract record -> real parser/probe/cache/host -> real gateway admission and lifecycle stop. All OS/killer ports are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { ProcessProbeCache } from '../lib/process-probe.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { AgentGateways } from '../lib/agent-gateways.mjs';
import { HermesGatewayBook } from '../lib/hermes-gateway-book.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { handleRequest } from '../lib/protocol.mjs';
const f = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));

class ResidentFixture {
  alive = true;
  held = true;
  killed = [];
  gatewayKills = [];
  bootId = f.token.bootId;
  constructor(t, { recordToken = f.token, tokenless = false } = {}) {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-resident-identity-'));
    t.after(() => fs.rmSync(this.home, { recursive: true, force: true }));
    const record = { ...f.legacyResident, ...(tokenless ? {} : { startToken: recordToken }) };
    const dir = path.join(this.home, 'residents'); fs.mkdirSync(dir);
    this.file = path.join(dir, `${record.agentId}.${record.lifetime}.json`);
    fs.writeFileSync(this.file, JSON.stringify(record));
    const noIO = () => { throw Error('unexpected OS subprocess'); };
    this.identity = new ProcessIdentityProbe({ platform: 'linux', run: noIO, runSync: noIO,
      state: pid => { assert.equal(pid, f.token.pid); return this.alive ? 'alive' : 'gone'; },
      readFile: file => {
        if (file === '/proc/sys/kernel/random/boot_id') return this.bootId;
        assert.ok([`/proc/${f.token.pid}/stat`, `/proc/${f.token.pid}/cmdline`].includes(file), 'only the synthetic recorded pid is observed');
        if (!this.alive) throw Object.assign(Error('fixture gone'), { code: 'ENOENT' });
        return file.endsWith('/stat') ? f.procStat : `bash\0${record.launcher}\0`;
      } });
    this.cache = new ProcessProbeCache({ identity: this.identity, nowMs: () => Math.floor(record.writtenAtUs / 1000) + 1000,
      state: pid => { assert.equal(pid, record.pid); return this.alive ? 'alive' : 'gone'; } });
    this.host = new AgentStateHost({ aifyHome: this.home, instance: 'residents', population: 'residents',
      nowUs: () => record.writtenAtUs + 1_000_000, probe: (pids, options) => this.cache.answers(pids, options) });
    this.host.boot();
    this.residents = {
      identity: id => this.held ? this.host.rawIdentity(id) : { current: null, unknown: true, conflict: false },
      enter: () => this.held ? { host: this.host, op: { live: () => this.held, done() {}, guard: () => assert.equal(this.held, true) } } : null,
    };
    this.book = new HermesGatewayBook({ aifyHome: this.home, isFree: async () => true, probe: async () => null,
      processes: async () => { throw Error('a fresh gateway slot must not activate a Linux process probe'); },
      kill: async pid => { this.gatewayKills.push(pid); } });
    this.gateways = new AgentGateways({ host: { rawIdentity: () => ({ current: null }) }, instance: 'managed', residents: this.residents, book: this.book });
    this.ports = createAgentLifecyclePorts({ aifyHome: this.home, machineId: 'fixture', stateHost: { rawIdentity: () => ({ current: null }) },
      residents: this.residents, runner: {}, definitions: {}, installed: async () => new Set(['hermes']),
      processIdentity: this.identity, settleMs: 0, killTree: async pid => { this.killed.push(pid); this.alive = false; } });
  }
  ask() {
    return handleRequest({ method: 'POST', path: `/agents/${f.legacyResident.agentId}/gateway`,
      body: { instance: 'residents', lifetime: f.legacyResident.lifetime, action: 'prepare' } }, { gateways: this.gateways });
  }
}

test('a matching contract resident is adopted without a fabricated epoch time, prepares its fresh gateway, then stops through the shared identity', async t => {
  const fixture = new ResidentFixture(t), raw = fixture.host.rawIdentity(f.legacyResident.agentId);
  assert.equal(raw.unknown, false); assert.equal(raw.conflict, false);
  assert.deepEqual(raw.current.startToken, f.token);
  assert.equal(Object.hasOwn(raw.current, 'createdAtUs'), false, 'a Linux token is never mislabeled as an epoch timestamp');
  const prepared = await fixture.ask();
  assert.equal(prepared.status, 200); assert.equal(prepared.body.ok, true); assert.equal(prepared.body.live, false);
  assert.equal(fixture.book.records().length, 1);
  assert.deepEqual(fixture.gatewayKills, [], 'fresh prepare grants no Linux gateway recovery/kill capability');
  assert.equal(await fixture.ports.stop(raw.current, 'resident'), true);
  assert.deepEqual(fixture.killed, [f.token.pid]);
  assert.equal(fs.existsSync(fixture.file), false, 'the injected killer made the process definitely gone before the host removed its record');
});

for (const [name, value] of [['legacy tokenless', undefined], ['malformed token', { ...f.token, startTicks: 1 }],
  ['different boot', { ...f.token, bootId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }]]) {
  test(`${name} contract resident stays unknown and cannot prepare a gateway`, async t => {
    const fixture = new ResidentFixture(t, value === undefined ? { tokenless: true } : { recordToken: value });
    const raw = fixture.host.rawIdentity(f.legacyResident.agentId);
    assert.equal(raw.current, null); assert.equal(raw.unknown, true);
    const refused = await fixture.ask(); assert.equal(refused.status, 409);
    assert.deepEqual(fixture.book.records(), []); assert.deepEqual(fixture.killed, []); assert.deepEqual(fixture.gatewayKills, []);
    assert.equal(fs.existsSync(fixture.file), true, 'an unverified record remains readable; it is not adopted or removed');
  });
}

test('a resident whose boot identity changes after adoption grants no stop despite an otherwise matching witness', async t => {
  const fixture = new ResidentFixture(t), witness = fixture.host.rawIdentity(f.legacyResident.agentId).current;
  assert.ok(witness);
  fixture.bootId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const stopped = await fixture.ports.stop(witness, 'resident');
  assert.deepEqual({ stopped, killed: fixture.killed, retained: fs.existsSync(fixture.file) },
    { stopped: false, killed: [], retained: true }, 'identity refusal must retain the record and make no killer call');
});
