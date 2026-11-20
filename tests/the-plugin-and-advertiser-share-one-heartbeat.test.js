import assert from 'node:assert/strict';
import test from 'node:test';
import { HostAdvertiser } from '../lib/host-advertiser.mjs';
import { postAdvertisement } from '../lib/post-advertisement.mjs';
import { ADVERTISEMENT_PATH, CommsApi } from '../lib/plugins/aify-comms/api.mjs';
import { createCommsPlugin, HEARTBEAT_INTERVAL_MS } from '../lib/plugins/aify-comms/index.mjs';
import { DashboardApi } from '../lib/plugins/aify-dashboard/dashboard-api.mjs';
import { readServices } from '../lib/services.mjs';
import { handleRequest } from '../lib/protocol.mjs';

const endpoint = 'http://comms.invalid';
const machineId = 'win32:fixture';
const advertisement = { hostname: 'fixture', kind: 'windows', machineId };

function fixture(t, { enabled = true, registryFields = {}, host = () => ({ ...advertisement, terminal: true }) } = {}) {
  let entry = { endpoint, ...registryFields }, now = 1, status = 200;
  const registry = () => JSON.stringify({ version: 1, services: { 'aify-comms': entry } });
  const [service] = readServices(registry());
  const requests = [], timers = [], notices = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST' && !url.endsWith('/claim')) {
      requests.push({ url, body: JSON.parse(options.body) });
      return new Response(status === 200 ? '{}' : 'denied', { status });
    }
    return new Response('{"requests":[],"controls":[]}', { status: 200 });
  };
  const api = new CommsApi({ endpoint, identity: { bridgeId: 'bridge' }, credential: async () => '', fetchImpl });
  let plugin;
  let running = false;
  const advertiser = new HostAdvertiser({ enabled, everyMs: 2_000, redetectMs: 300_000, now: () => now,
    readRegistry: registry, host, harnesses: () => [{ client: 'codex', found: true }], pathFor: () => ADVERTISEMENT_PATH,
    pluginTargets: () => running ? [plugin.capabilities.heartbeatTarget()].filter(Boolean) : [],
    credentialReading: () => ({ env: {}, root: 'C:/no-actual-read' }), credential: async () => '', env: {},
    post: (url, body, key, name) => postAdvertisement(url, body, key, name, { proofFor: () => '', fetchImpl }),
    say: line => notices.push(line) });
  plugin = createCommsPlugin({ endpoint, service, api, machineId, advertisement: () => advertisement,
    carryAdvertisement: target => advertiser.forPlugin(target), setTimeoutImpl: (callback, ms) => {
      const timer = { callback, ms }; timers.push(timer); return timer;
    }, clearTimeoutImpl: () => {} });
  t.after(() => plugin.stop());
  return { advertiser, plugin, requests, notices, replace: fields => { entry = { ...entry, ...fields }; },
    async start() { await plugin.start({ processes: { list: () => [] }, log: line => notices.push(line) }); running = true; },
    beat: () => timers.findLast(timer => timer.ms === HEARTBEAT_INTERVAL_MS).callback(),
    setStatus: value => { status = value; }, setNow: value => { now = value; } };
}

test('one matching beat carries claimer and host facts; its receipt drives advertising status', async t => {
  const f = fixture(t);
  await f.start();
  await f.advertiser.beat();
  assert.deepEqual(f.requests.map(row => row.url), [endpoint + ADVERTISEMENT_PATH], 'one POST, not two writers');
  const [{ body }] = f.requests;
  assert.deepEqual([body.machineId, body.bridgeId, body.terminal, body.terminalRuntimes, body.metadata.heldTerminals],
    [machineId, 'bridge', true, ['codex'], []]);
  assert.equal((await f.advertiser.healthFields()).advertising, true);
  f.setNow(30_000);
  assert.equal((await f.advertiser.healthFields()).advertising, true, 'matches carrier cadence, not standalone interval');
  f.setNow(100_000);
  assert.equal((await f.advertiser.healthFields()).advertising, false, 'silence still expires acceptance');
  f.setStatus(200); await f.beat();
  assert.equal((await f.advertiser.healthFields()).advertising, true);
  f.setStatus(401); await f.beat();
  const health = await f.advertiser.healthFields();
  assert.equal(health.advertising, false);
  assert.equal(health.advertiseAttempts['aify-comms'].status, 401);
  const contact = f.plugin.capabilities.serviceContact();
  assert.equal(contact.ok, false);
  assert.match(contact.error, /401.*denied/);
  const reply = await handleRequest({ method: 'GET', path: '/health' }, {
    runner: { list: () => [] }, serviceContacts: [contact], rosterRevision: 'changed',
  });
  assert.deepEqual(reply.body.serviceContacts, [contact], 'the actual local route carries the failed contact');
  assert.equal(reply.body.rosterRevision, 'changed');
  assert.equal(f.requests.length, 3, 'health did not make a fourth request');
});

test('a separate advertisement route is kept; opt-outs keep only the claimer beat', async t => {
  const separate = fixture(t, { registryFields: { advertisement: { path: '/another-beat' } } });
  await separate.start(); await separate.advertiser.beat();
  assert.deepEqual(separate.requests.map(row => [row.url, Object.hasOwn(row.body, 'terminal')]),
    [[endpoint + ADVERTISEMENT_PATH, false], [endpoint + '/another-beat', true]]);
  for (const options of [{ enabled: false }, { registryFields: { advertise: false } }]) {
    const off = fixture(t, options);
    await off.start();
    if (options.enabled !== false) await off.advertiser.beat();
    assert.equal(off.requests.length, 1);
    assert.equal(off.requests[0].body.bridgeId, 'bridge');
    assert.equal(Object.hasOwn(off.requests[0].body, 'terminal'), false);
    assert.equal((await off.advertiser.healthFields()).advertising, false);
  }
});

test('applying a remote definition edit changes the roster even before a snapshot push succeeds', async t => {
  const row = { id: 'definition-edit' };
  const reports = [], timers = [];
  let requests = [], applied = 0;
  const plugin = createCommsPlugin({ endpoint, machineId, advertisement: () => advertisement,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); }, clearTimeoutImpl: () => {},
    definitions: {
      async applyRequest(request) { assert.equal(request, row); applied++; return { status: 'done' }; },
      async snapshot() { return { complete: true, storeId: 'store', revision: 2, entries: [] }; },
    }, api: {
      async heartbeat() { return {}; }, async claim() { return {}; }, async claimControls() { return { controls: [] }; },
      async claimDefinitionRequests() { const ready = requests; requests = []; return { requests: ready }; },
      async reportDefinitionRequest(...args) { reports.push(args); },
      async pushDefinitions() { throw Error('this service did not accept the snapshot'); },
    } });
  t.after(() => plugin.stop());
  await plugin.start({ processes: { list: () => [] }, log: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  const revision = () => plugin.capabilities.agents.revision?.() ?? null;
  const before = revision();
  const firstPass = timers.find(timer => timer.ms === 10_000);
  assert.ok(firstPass, 'the initial empty claim completed');
  requests = [row]; firstPass.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([applied, reports.length], [1, 1]);
  assert.equal(plugin.state().definitions.published, null);
  assert.notDeepEqual(revision(), before, 'the committed edit, not a timer or successful push, is the signal');
  const after = revision();
  timers.findLast(timer => timer.ms === 10_000).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(revision(), after, 'no second change on an empty claim');
});

test('a provider wait records success, refusal and no false cancellation', async () => {
  let status = 200;
  const api = new DashboardApi({ endpoint: 'http://dashboard.invalid', credential: async () => 'fixture-only',
    fetch: async () => new Response(status === 200 ? '{}' : '{"error":"refused"}', { status }) });
  assert.equal(api.providerContact, null);
  await api.providerPending('fixture');
  assert.equal(api.providerContact.ok, true);
  status = 403;
  await assert.rejects(api.providerPending('fixture'), /403.*refused/);
  assert.equal(api.providerContact.ok, false);
  assert.match(api.providerContact.error, /403.*refused/);
  const returned = api.providerContact;
  await assert.rejects(api.providerPending('fixture', { signal: AbortSignal.abort() }), /stopped before/);
  assert.deepEqual(api.providerContact, returned);
});
