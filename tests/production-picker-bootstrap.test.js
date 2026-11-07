import test from 'node:test';
import assert from 'node:assert/strict';
import { hostIdentityFacts } from '../lib/advertise.mjs';
import { ServicePlugins } from '../lib/service-plugins.mjs';
import { startDaemonPlugins } from '../lib/daemon-plugin-bootstrap.mjs';
import { pluginsForServices } from '../lib/plugins/index.mjs';
import { readServices } from '../lib/services.mjs';
import { handleRequest } from '../lib/protocol.mjs';
import { BootFixture } from './fixtures/daemon-boot.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();

// Real boot API, shared payload, service factory, plugin, starter and GET route.
// State/socket/view effects are fake ports; no source slicing, operator profile or daemon entry import.
async function picker(t, facts, identity = hostIdentityFacts, context = {}) {
  const expected = hostIdentityFacts(facts).machineId;
  const agent = (machineId, owner) => ({ machineId, sessionMode: 'managed', status: 'available',
    ...(owner === undefined ? {} : { definition: { state: 'defined', ownerMachineId: owner } }) });
  const registry = new ServicePlugins();
  t.after(() => registry.stopAll());
  let reads = 0;
  const api = {
    heartbeat: async () => ({}), claim: async () => ({}),
    agents: async () => {
      reads++;
      return { agents: { local: agent(expected, expected), remote: agent(`${expected}-other`, `${expected}-other`), unknown: agent('') } };
    },
  };
  const runner = { list: () => [], instance: () => 'fixture-runner', start: () => assert.fail('listing must not spawn'),
    stop: () => assert.fail('listing must not stop a process') };
  const reports = [], f = new BootFixture();
  // A memory-only empty store supplies boot's warning read when this picker case needs no definitions.
  const emptyStore = { list: async () => ({ definitions: [] }), snapshot: async () => ({ complete: false, incomplete: {} }) };
  f.options.runner = runner; f.options.plugins = registry;
  f.options.definitions = context.definitionStore ?? emptyStore;
  f.options.env = facts.env; f.options.windows = facts.platform === 'win32';
  f.options.identity = () => ({ hostname: facts.hostname, ...identity(facts) });
  f.options.roots = () => [];
  f.options.installed = () => new Set((context.installedHarnesses?.(context.aifyLauncherFilesOnPath?.() ?? []) ?? []).map(row => row.client));
  f.options.readRegistry = () => JSON.stringify({ version: 1, services: { 'aify-comms': { endpoint: 'http://example.invalid' } } });
  f.options.readServices = () => readServices(f.options.readRegistry());
  f.options.credential = async () => 'test-only';
  f.options.advertisement = () => ({ hostname: facts.hostname, kind: 'test' });
  f.options.log = () => {};
  f.options.report = line => reports.push(`[aify-env] ${line}\n`);
  f.options.advertising = false;
  f.options.buildPlugins = (services, shared) => pluginsForServices(services, {
    ...shared, api, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
  });
  f.factories.plugins = context.startDaemonPlugins ?? startDaemonPlugins;
  const result = await f.boot();
  context.afterBoot?.();
  assert.equal(typeof result.followServices, 'function');
  assert.deepEqual(registry.report().map(plugin => plugin.name), ['aify-comms']);
  assert.ok(reports.some(line => /hosting work for: aify-comms/.test(line)));
  assert.ok(reports.every(line => !/failed|refused/.test(line)), 'production startup reports no failed plugin');
  const answer = await handleRequest({ method: 'GET', path: '/agents/startable' }, { runner, agents: registry.capability('agents') });
  return { answer, reads };
}

const definesLocalAndRemote = () => ({
  definitionStore: {
    async list() { return { storeId: 's1', definitions: ['local', 'remote'].map(id => ({ id, problems: [], agent: { id, mode: 'managed' } })) }; },
    async snapshot() { return { complete: false, incomplete: {} }; },
  },
  installedHarnesses: () => [], aifyLauncherFilesOnPath: () => [],
});

for (const facts of [
  { platform: 'win32', hostname: 'fallback', env: { COMPUTERNAME: 'Picker-Windows' }, isWsl: false },
  { platform: 'linux', hostname: 'Picker-WSL', env: {}, isWsl: true },
]) {
  test(`production bootstrap supplies canonical ${facts.platform}/${facts.isWsl} identity to picker`, async t => {
    const { answer, reads } = await picker(t, { ...facts, exists: () => false }, hostIdentityFacts, definesLocalAndRemote());
    assert.equal(answer.status, 200);
    assert.equal(answer.body.problem, '', 'bootstrap lost machine identity before the picker');
    assert.equal(reads, 1, 'the real starter must reach the roster');
    assert.deepEqual(answer.body.agents.map(agent => agent.id), ['local'], 'other and unknown hosts must remain excluded');
  });
}

test('production bootstrap preserves fail-closed behavior if the identity producer cannot answer', async t => {
  const facts = { platform: 'linux', hostname: 'Picker', env: {}, isWsl: false, exists: () => false };
  const { answer, reads } = await picker(t, facts, () => ({ machineId: '' }));
  assert.match(answer.body.problem, /cannot say which machine/);
  assert.deepEqual(answer.body.agents, []);
  assert.equal(reads, 0, 'missing identity must not widen the roster query');
});

test("THE DAEMON'S PLUGIN HOST offers every started plugin's spawnEnv, asked when a start asks, not captured at boot", async t => {
  const given = [];
  const recording = options => { given.push(options); return startDaemonPlugins(options); };
  const facts = { platform: 'win32', hostname: 'fallback', env: { COMPUTERNAME: 'Picker-Windows' }, isWsl: false, exists: () => false };
  await picker(t, facts, hostIdentityFacts, { startDaemonPlugins: recording });
  assert.equal(given.length, 1);
  assert.equal(typeof given[0].spawnEnv, 'function', 'a function, so it is asked at each start');
  assert.deepEqual(given[0].spawnEnv(), [], 'aify-comms offers none');
  const offered = { service: 'later', contribute: async () => ({ env: {} }) };
  await given[0].registry.add({ name: 'later', start() {}, stop() {}, capabilities: { spawnEnv: offered } }, {});
  const late = given[0].spawnEnv();
  assert.deepEqual({ count: late.length, same: late[0] === offered }, { count: 1, same: true },
    'a plugin started after boot is asked too');
});

test("THE DAEMON'S DEFINITION STORE AND INSTALLED HARNESSES reach the plugin it starts (P0 C3, C7)", async t => {
  let phase = 'boot';
  const seen = { boot: 0, picker: 0, installed: null };
  const definitionStore = {
    async list() { seen[phase]++; return { storeId: 's1', definitions: [] }; },
    async snapshot({ installed }) { seen.installed = [...installed].sort(); return { complete: false, incomplete: {} }; },
  };
  const facts = { platform: 'win32', hostname: 'fallback', env: { COMPUTERNAME: 'Picker-Windows' }, isWsl: false, exists: () => false };
  const { answer } = await picker(t, facts, hostIdentityFacts, {
    definitionStore, installedHarnesses: () => [{ client: 'claude' }, { client: 'codex' }],
    aifyLauncherFilesOnPath: () => [], afterBoot: () => { phase = 'picker'; },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual({ boot: seen.boot, picker: seen.picker }, { boot: 1, picker: 1 }, 'boot warning and real starter reads remain separately visible');
  const deadline = Date.now() + 5000;
  while (seen.installed === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(seen.installed, ['claude', 'codex'], 'the sync was handed what this host can launch');
});
