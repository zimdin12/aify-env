import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { handleRequest } from '../lib/protocol.mjs';
import { ServicePlugins, PluginProcesses } from '../lib/service-plugins.mjs';
import { LifecycleSync } from '../lib/plugins/aify-comms/lifecycle-sync.mjs';
import { LifecycleLaunch } from '../lib/plugins/aify-comms/lifecycle-launch.mjs';
import { buildStartSpec } from '../lib/start-spec.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/terminal-controls.mjs';
import { workspaceWithinRoots } from '../lib/plugins/aify-comms/claim.mjs';
import { BootFixture, deferred } from './fixtures/daemon-boot.mjs';

const lifetime = '11111111-1111-4111-8111-111111111111';
const text = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1"\n';

async function rig(t, { contributor = null, needsSecrets = false, beforeSpawn = () => {}, blockBirth = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'defined-local-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const launcher = path.join(home, 'claude-aify');
  fs.writeFileSync(launcher, text);
  const aifyHome = path.join(home, '.aify');
  const journal = new LifecycleJournal({ file: path.join(aifyHome, 'agent-lifecycle.json') });
  journal.initialize({ priorBoot: false });
  const state = new AgentStateHost({ aifyHome, instance: 'fixture', probe: () => new Map(), nowUs: () => 1_700_000_000_001_000 });
  state.boot();
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  const installed = new Set(['claude']);
  const agent = { name: 'Lead', role: 'coder', harness: 'claude', mode: 'managed', workspace: home,
    model: '', effort: '', instructions: '', env: { DEMO: 'definition' }, herdrSpace: false,
    ...(needsSecrets ? { secrets: { project: 'fixture', names: ['FIXTURE_SECRET'] } } : {}) };
  await definitions.set('lead', agent, { installed });
  const { storeId, definitions: [reading] } = await definitions.list();
  const definition = { storeId, incarnation: reading.incarnation, revision: reading.revision };
  const remote = { id: 'remote-start', agentId: 'lead', machineId: 'fixture-machine', storeId,
    expectedIncarnation: reading.incarnation, expectedRevision: reading.revision, expectedLifetime: null,
    action: 'start', requestedBy: 'operator' };
  let roots = [home], listener;
  const entered = deferred(), release = deferred(), births = [], carriers = [], attaches = [], reports = [], frames = [];
  t.after(() => release.resolve());
  const runner = {
    instance: () => 'fixture-runner', list: () => births.map(() => ({ id: 'worker', pid: 71 })), screenSightings: () => [],
    async start(spec, { admitSpawn }) {
      beforeSpawn(() => { roots = []; });
      await admitSpawn(spec.cwd);
      assert.equal(fs.existsSync(path.join(home, 'definitions', '.lock')), true, 'birth runs under the real definition lock');
      births.push(spec);
      entered.resolve();
      if (blockBirth) await release.promise;
      state.startManaged({ agentId: 'lead', lifetime, instance: 'fixture', handle: 'worker', pid: 71, definition });
      return { id: 'worker', pid: 71 };
    },
    subscribe(id, out) { carriers.push(id); listener = out; return () => {}; },
  };
  const plugins = new ServicePlugins();
  const boot = new BootFixture();
  Object.assign(boot.options, { home, definitions, installed: () => installed, runner, plugins, roots: () => roots,
    readServices: () => contributor ? [{ name: 'fixture-service' }] : [], advertising: false });
  Object.assign(boot.factories, {
    state: () => ({ ...boot.state, host: state, lifecycleOwner: null,
      residents: { ...boot.state.residents, identity: id => state.rawIdentity(id) } }),
    lifecycle: options => createAgentLifecyclePorts({ ...options, localLaunch: { platform: 'linux',
      resolve: name => { assert.equal(name, 'claude-aify'); return [launcher]; },
      baseEnv: { PATH: '', aify_agent_id: 'parent', CLAUDE_SESSION_ID: 'parent', AIFY_AGENT_LEASE: 'parent',
        CLAUDE_CODE_CHILD_SESSION: '1', aify_definition_revision: '77', AIFY_DEFINITION_INCARNATION: '42',
        AIFY_CHANNEL_ROUTE: 'parent-route', PI_SESSION_ID: 'parent', OMP_SESSION_ID: 'parent', AIFY_PI_SESSION_ID: 'parent' },
    } }),
    plugins: async ({ registry, readServices }) => {
      for (const { name } of readServices()) await registry.add({ name, start() {}, stop() {}, capabilities: { spawnEnv: contributor } }, {});
      return () => {};
    },
  });
  await boot.boot();
  const ports = boot.session.agentState.lifecycle;
  const request = (method = 'POST', suffix = 'lead/start', agents = plugins.capability('agents')) =>
    handleRequest({ method, path: `/agents/${suffix}`, body: {} }, { agents, lifecycle: ports });
  const api = {
    async claimLifecycleRequests() { return { requests: [remote] }; },
    async prepareLifecycleLaunch() { return { ok: true, launch: { agentId: 'lead', runtime: 'claude-code', terminalId: 'term',
      argv: [launcher, '--remote'], cwd: home, env: {}, definition, herdrSpace: false } }; },
    async reportLifecycleAttachment(_env, _id, _machine, body) { attaches.push(body); return { ok: true, attachment: body }; },
    async reportLifecycleRequest(_env, _id, _machine, body) { reports.push(body); },
  };
  const adapter = new LifecycleLaunch({ api, machineId: 'fixture-machine', definitions, identity: ports.rawIdentity,
    handles: createHandleBook(), cwdRoots: () => roots, windows: false, withinRoots: workspaceWithinRoots,
    resolveCandidates: () => [launcher], buildSpec: input => buildStartSpec(input, { readFile: () => text, platform: 'linux' }),
    definitionFor: value => definitions.boundReading(value), spawnEnv: () => plugins.capabilities('spawnEnv'),
    processes: new PluginProcesses(runner, { cwdRoots: () => roots, windows: false }),
    sender: { send: (id, chunk) => frames.push([id, chunk]) },
  });
  const sync = new LifecycleSync({ api, lifecycle: ports.lifecycle, machineId: 'fixture-machine', plugin: adapter });
  return { request, boot, ports, home, definition, definitions, births, entered, release, carriers, attaches, reports, frames,
    remote: () => sync.pass('fixture-environment'), output: chunk => listener(chunk) };
}

for (const registered of [false, true]) test(`a local defined start works with ${registered ? 'a non-comms contributor' : 'an empty registry'}`, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => assert.fail('a local start sent an unexpected network request'));
  const f = await rig(t, { needsSecrets: registered, contributor: registered ? { field: 'secrets', contribute() {
    calls++;
    return { env: { FIXTURE_SECRET: 'fixture-only' } };
  } } : null });
  const list = await f.request('GET', 'startable');
  assert.equal(list.status, 200, 'local picker must not require a service');
  assert.deepEqual(list.body.agents.map(row => row.id), ['lead']);
  assert.equal(f.boot.captured.view.agents(), f.ports.localStarts, 'agentStartPort gives the TUI the same localAgentStarts port');
  const answer = await f.request();
  assert.equal(answer.status, 200, answer.body.problem);
  assert.equal(f.births.length, 1);
  const [spec] = f.births;
  assert.deepEqual(spec.definition, f.definition);
  assert.deepEqual(spec.args.slice(-2), ['--aify-agent', 'lead']);
  assert.equal(spec.service, 'aify-env');
  assert.equal(spec.cwd, f.home);
  assert.equal(spec.env.AIFY_AGENT_ID, 'lead');
  assert.equal(spec.env.AIFY_SESSION_MODE, 'managed');
  for (const name of ['aify_agent_id', 'CLAUDE_SESSION_ID', 'AIFY_AGENT_LEASE', 'CLAUDE_CODE_CHILD_SESSION',
    'aify_definition_revision', 'AIFY_DEFINITION_INCARNATION', 'AIFY_CHANNEL_ROUTE', 'PI_SESSION_ID', 'OMP_SESSION_ID', 'AIFY_PI_SESSION_ID']) {
    assert.equal(name in spec.env, false, `local launch inherited ${name} from its parent`);
  }
  assert.equal(spec.env.DEMO, 'definition');
  assert.equal(spec.env.FIXTURE_SECRET, registered ? 'fixture-only' : undefined);
  assert.equal(calls, Number(registered));
  assert.equal(f.ports.rawIdentity('lead').current.lifetime, lifetime);
  assert.deepEqual(f.carriers, []);
  assert.deepEqual(f.attaches, []);
});

test('composeDefinedLaunch refuses a named secret without a contributor before any birth', async t => {
  const f = await rig(t, { needsSecrets: true });
  const reply = await f.request();
  assert.equal(reply.status, 409);
  assert.match(reply.body.problem, /no plugin started on this host supplies/);
  assert.deepEqual(f.births, []);
});

test('revoking the root at Runner admission refuses the local birth', async t => {
  const f = await rig(t, { beforeSpawn: revoke => revoke() });
  const reply = await f.request();
  assert.equal(reply.status, 409);
  assert.match(reply.body.problem, /outside this host's launch roots/);
  assert.deepEqual(f.births, []);
});

test('a remote refusal does not become a successful local Start', async t => {
  const f = await rig(t);
  const remote = { start: async () => ({ started: false, problem: 'service refused' }) };
  assert.equal((await f.request('POST', 'lead/start', remote)).body.problem, 'service refused');
  assert.deepEqual(f.births, []);
});

for (const first of ['local', 'remote']) test(`${first} wins the local-vs-remote race without a duplicate birth`, async t => {
  const f = await rig(t, { blockBirth: true });
  const runLocal = () => f.request();
  const runRemote = () => f.remote();
  const winner = first === 'local' ? runLocal() : runRemote();
  await Promise.race([f.entered.promise, winner.then(() => assert.fail('the first route did not reach birth'))]);
  // The remote contender hits the pending journal slot while the local birth holds the lock.
  // The local contender first has to read the store, so observe that wait before releasing the remote birth.
  let pendingLoser;
  if (first === 'local') {
    const rejected = await runRemote();
    f.release.resolve();
    assert.equal(f.reports[0]?.outcome, 'agent-reserved', 'remote contender must hit the shared pending journal slot');
    pendingLoser = Promise.resolve(rejected);
  } else {
    const reading = deferred();
    const list = f.definitions.list.bind(f.definitions);
    const observed = t.mock.method(f.definitions, 'list', (...args) => { reading.resolve(); return list(...args); });
    pendingLoser = runLocal();
    const beganReading = await Promise.race([reading.promise.then(() => true), pendingLoser.then(() => false)]);
    observed.mock.restore();
    if (!beganReading) f.release.resolve();
    assert.equal(beganReading, true, 'the local contender did not reach the store read');
  }
  f.release.resolve();
  const [result, loser] = await Promise.all([winner, pendingLoser]);
  assert.equal(f.births.length, 1, 'both routes reached a worker birth for one definition');
  if (first === 'local') {
    assert.equal(result.status, 200);
    assert.equal(loser.outcome, 'synced');
    assert.equal(f.reports[0].status, 'refused', 'remote contender must lose safely');
    assert.deepEqual(f.carriers, []);
    assert.deepEqual(f.attaches, []);
  } else {
    assert.equal(loser.status, 409);
    assert.equal(result.outcome, 'synced');
    assert.equal(f.reports[0].status, 'done');
    assert.deepEqual(f.carriers, ['worker']);
    assert.deepEqual(f.attaches, [{ terminalId: 'term', handle: 'worker', processId: 71, lifetime }]);
    f.output('PTY data');
    assert.deepEqual(f.frames, [['term', 'PTY data']]);
  }
});
