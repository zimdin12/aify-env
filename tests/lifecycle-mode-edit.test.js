// Desired mode is next-start configuration, not the ownership of a lifetime already running.
// Real stores, role locks, state hosts and Runner registration; only child/probe/kill are fixture-owned fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { DaemonResidents } from '../lib/daemon-residents.mjs';
import { Runner } from '../lib/runner.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';

async function fixture(t, mode) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'lifecycle-mode-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'env'));
  fs.writeFileSync(path.join(home, 'env', 'residents.generation'), '400\n');
  fs.writeFileSync(path.join(home, 'agent-lifecycle.json'), JSON.stringify({ version: 1, records: {}, stops: {} }));
  const lifetime = '7f3c9e2a-0000-4000-8000-0000000000e1';
  const pid = 424242, written = 1_790_950_000_000_000;
  let alive = true;
  const effects = [];
  const probe = pids => new Map(pids.map(id => [id, id === pid && alive
    ? { alive: true, createdAtUs: written - 1, commandLine: `node "${process.execPath}"` }
    : { alive: false, createdAtUs: null, commandLine: null }]));
  if (mode === 'resident') {
    fs.mkdirSync(path.join(home, 'residents'));
    fs.writeFileSync(path.join(home, 'residents', `a.${lifetime}.json`), JSON.stringify({ agentId: 'a', lifetime,
      instance: 'residents', harness: 'hermes', pid, launcher: process.execPath, writtenAtUs: written }));
  }
  const host = new AgentStateHost({ aifyHome: home, instance: 'managed-owner', probe, nowUs: () => written + 1000, population: 'managed' });
  host.boot();
  const residents = new DaemonResidents({ aifyHome: home, url: 'http://127.0.0.1:1', pid: process.pid, probe, nowUs: () => written + 1000 });
  t.after(() => residents.release({ waitMs: 0 }));
  // A managed stop must not acquire a residents role merely because its next mode says resident.
  if (mode === 'resident') assert.equal(await residents.acquire(), true);
  const child = new EventEmitter();
  child.pid = pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {} };
  child.kill = () => { effects.push('managed-console'); alive = false; child.emit('close', null, 'SIGTERM'); };
  const runner = new Runner({ openTerminal: null, spawnProcess: () => child, ownedFile: null, loadCheckpoint: null,
    managedHost: () => ({ host, instance: 'managed-owner', url: 'http://127.0.0.1:12345' }),
    isAlive: () => alive, killTree: async () => { effects.push('managed-tree'); } });
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  const agent = { name: 'A', role: 'worker', harness: 'hermes', mode, workspace: home,
    model: '', effort: '', instructions: '', env: {}, herdrSpace: false };
  await definitions.set('a', agent, { installed: new Set(['hermes']) });
  if (mode === 'managed') await runner.start({ agentId: 'a', service: 'fixture', command: 'fixture', env: {},
    fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"' });
  const ports = createAgentLifecyclePorts({ aifyHome: home, machineId: 'm', stateHost: host, residents, runner, definitions,
    probe: async pids => probe(pids), isAlive: () => alive, settleMs: 0,
    killTree: async id => { assert.equal(id, pid); effects.push('resident'); alive = false; },
    installed: async () => new Set(['hermes']) });
  const before = ports.rawIdentity('a');
  assert.equal(before.unknown, false, 'fixture producer must provide a known lifetime');
  assert.ok(before.current?.lifetime);
  await definitions.set('a', { ...agent, mode: mode === 'resident' ? 'managed' : 'resident' }, { installed: new Set(['hermes']) });
  const listing = await definitions.list(), row = listing.definitions[0];
  const request = action => ({ id: `r-${action}`, agentId: 'a', machineId: 'm', storeId: listing.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: before.current.lifetime,
    action, requestedBy: 'fixture' });
  return { home, ports, effects, runner, residents, host, definitions, before, request };
}

for (const mode of ['resident', 'managed']) for (const action of ['stop', 'kill']) {
  test(`${mode} lifetime ${action} uses its actual owner after the definition changes mode`, async t => {
    const f = await fixture(t, mode);
    const answer = await f.ports.lifecycle.execute(f.request(action));
    assert.deepEqual([answer.status, answer.outcome], ['done', action], 'edited next-start mode must not choose the stop adapter');
    assert.deepEqual(f.effects, mode === 'resident' ? ['resident'] : ['managed-console', 'managed-tree']);
    assert.equal(f.ports.rawIdentity('a').current, null, 'the matching lifetime is ended');
    assert.equal(f.runner.list().length, 0);
    assert.equal(f.ports.stopFacts().size, action === 'stop' ? 1 : 0);
  });
}

for (const action of ['start', 'restart']) test(`${action} refuses an edited resident lifetime before effects`, async t => {
  const f = await fixture(t, 'resident');
  const answer = await f.ports.lifecycle.execute(f.request(action));
  assert.deepEqual([answer.status, answer.outcome], ['refused', 'running-lifetime-mode-mismatch']);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.ports.rawIdentity('a'), f.before, 'refusal leaves the resident lifetime untouched');
  assert.equal(f.ports.stopFacts().size, 0);
  const stopped = await f.ports.lifecycle.execute(f.request('stop'));
  assert.equal(stopped.status, 'done', 'control: the same edited state can still be stopped');
  assert.deepEqual(f.effects, ['resident']);
});

for (const change of ['role lost', 'lifetime moved']) test(`edited resident stop refuses when ${change}`, async t => {
  const f = await fixture(t, 'resident');
  const locked = f.definitions.withLifecycleDefinition.bind(f.definitions);
  f.definitions.withLifecycleDefinition = async work => {
    if (change === 'role lost') await f.residents.release({ waitMs: 0 });
    else {
      const directory = path.join(f.home, 'residents');
      const old = path.join(directory, fs.readdirSync(directory)[0]);
      const record = JSON.parse(fs.readFileSync(old));
      fs.rmSync(old);
      record.lifetime = '7f3c9e2a-0000-4000-8000-0000000000e2';
      fs.writeFileSync(path.join(directory, `a.${record.lifetime}.json`), JSON.stringify(record));
    }
    return locked(work);
  };
  const answer = await f.ports.lifecycle.execute(f.request('stop'));
  assert.equal(answer.status, 'refused');
  assert.equal(answer.outcome, change === 'role lost' ? 'identity-unknown' : 'lifetime-moved');
  assert.deepEqual(f.effects, []);
  assert.equal(f.ports.stopFacts().size, 0);
});

for (const kind of ['both', 'neither']) test(`ambiguous ${kind} witness refuses before every stop effect`, async t => {
  const f = await fixture(t, 'managed');
  const witness = { ...f.before.current };
  if (kind === 'both') Object.assign(witness, { launcher: 'resident-cli', createdAtUs: 1000 });
  else delete witness.handle;
  // Deliberately malformed collaborator input, not a claim that a current producer emits it.
  f.host.startManaged(witness);
  const answer = await f.ports.lifecycle.execute(f.request('stop'));
  assert.deepEqual([answer.status, answer.outcome], ['refused', 'lifetime-kind-unknown']);
  assert.equal(await f.ports.stop(witness, 'managed'), false, 'direct adapter also refuses ambiguity');
  assert.deepEqual(f.effects, []);
});
