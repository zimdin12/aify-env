// The gateway route admits a request once, and the book then awaits (a probe, the OS) before its effects. A request
// whose admission ended during that wait must not apply: a released residents owner wrote over its successor's record,
// and a replaced managed lifetime was handed its old gateway's credentials (review of 85cbd1a, A2; these are the
// reviewer's fixtures, asserting the corrected outcome). The real role, host, route and book; fake probes and processes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentGateways } from '../lib/agent-gateways.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { DaemonResidents } from '../lib/daemon-residents.mjs';
import { HermesGatewayBook } from '../lib/hermes-gateway-book.mjs';
import { handleRequest } from '../lib/protocol.mjs';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const nowUs = Date.now() * 1000;
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const safeDeps = { probe: async () => null, isFree: async () => true, processes: async () => new Map(), kill: async () => { throw new Error('unexpected kill'); } };

/** The OS confirming pid 5001 as the hermes gateway on `port()`, as it is for a registered gateway still running. */
const gatewayPid = (port) => async (pids) => new Map(pids.map((pid) => [pid, pid === 5001
  ? { alive: true, commandLine: `C:/fake/hermes.exe dashboard --port ${port()}` } : { alive: false }]));

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-gateway-fence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function managed(aifyHome, rows) {
  const host = new AgentStateHost({ aifyHome, instance: 'default', population: 'managed', nowUs: () => nowUs, probe: () => new Map() });
  host.boot();
  for (const [agentId, lifetime] of rows) {
    host.startManaged({ agentId, lifetime, instance: 'default', harness: 'hermes', pid: 4321, launcher: 'C:/owned/hermes-aify', writtenAtUs: nowUs - 1000 });
  }
  return host;
}

function askFor(host, book, residents = null) {
  const gateways = new AgentGateways({ host, instance: 'default', book, residents });
  return (agentId, lifetime, action = 'prepare', extra = {}, instance = 'default') => handleRequest(
    { method: 'POST', path: `/agents/${agentId}/gateway`, body: { instance, lifetime, action, ...extra } }, { gateways });
}

test('a released residents owner cannot write over its successor\'s record', async (t) => {
  const aifyHome = home(t);
  fs.mkdirSync(path.join(aifyHome, 'residents'));
  const writeResident = (lifetime) => fs.writeFileSync(path.join(aifyHome, 'residents', `resident-agent.${lifetime}.json`), JSON.stringify(
    { agentId: 'resident-agent', lifetime, instance: 'residents', harness: 'hermes', pid: 4321, launcher: 'C:/owned/hermes-aify', writtenAtUs: nowUs - 1000 }));
  const probe = (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: nowUs - 2000, commandLine: 'bash.exe C:/owned/hermes-aify' }]));
  const makeResidents = () => new DaemonResidents({ aifyHome, url: 'http://127.0.0.1:12345', pid: process.pid, probe, nowUs: () => nowUs });
  const oldRole = makeResidents();
  t.after(() => oldRole.release({ waitMs: 0 }));
  assert.equal(await oldRole.acquire(), true, JSON.stringify(oldRole.report()));
  writeResident(L1);
  const entered = gate();
  const held = gate();
  const live = new Set([5001]);
  const kills = [];
  let recordedPort;
  const processDeps = {
    processes: async (pids) => new Map(pids.map((pid) => [pid, live.has(pid) ? { alive: true, commandLine: `C:/fake/hermes.exe dashboard --port ${recordedPort}` } : { alive: false }])),
    kill: async (pid) => { kills.push(pid); live.delete(pid); return true; },
  };
  const oldAsk = askFor(managed(aifyHome, []), new HermesGatewayBook({ ...safeDeps, ...processDeps, aifyHome,
    probe: async () => { entered.resolve(); await held.promise; return null; } }), oldRole);
  recordedPort = (await oldAsk('resident-agent', L1, 'prepare', {}, 'residents')).body.port;
  assert.equal((await oldAsk('resident-agent', L1, 'register', { port: recordedPort, pid: 5001 }, 'residents')).status, 200);

  const pending = oldAsk('resident-agent', L1, 'prepare', {}, 'residents');
  await entered.promise;
  assert.equal((await oldRole.release()).abandoned, 1, 'control: the held request outlived the release');
  fs.rmSync(path.join(aifyHome, 'residents', `resident-agent.${L1}.json`));
  writeResident(L2);
  const newRole = makeResidents();
  t.after(() => newRole.release({ waitMs: 0 }));
  assert.equal(await newRole.acquire(), true);
  const newBook = new HermesGatewayBook({ ...safeDeps, ...processDeps, aifyHome });
  const newAsk = askFor(managed(aifyHome, []), newBook, newRole);
  const fresh = await newAsk('resident-agent', L2, 'prepare', {}, 'residents');
  assert.equal((await newAsk('resident-agent', L2, 'register', { port: fresh.body.port, pid: 9002 }, 'residents')).status, 200);

  held.resolve();
  const stale = await pending;
  assert.deepEqual([stale.status, stale.body.reason], [409, 'not-owner']);
  const [{ record }] = newBook.records();
  assert.deepEqual([record.lifetime, record.pid], [L2, 9002], 'the successor\'s record stands');
  assert.deepEqual(kills, [5001], 'the successor ended only the original gateway');
});

test('a lifetime replaced during the probe is not handed the old gateway\'s credentials', async (t) => {
  const aifyHome = home(t);
  const host = managed(aifyHome, [['hermes-agent', L1]]);
  const entered = gate();
  const held = gate();
  let probing = false;
  let recordedPort;
  const book = new HermesGatewayBook({ ...safeDeps, aifyHome, processes: gatewayPid(() => recordedPort), probe: async ({ port }) => {
    if (!probing) { probing = true; entered.resolve(); await held.promise; }
    return { port, token: 'old-lifetime-token', wsUrl: `ws://127.0.0.1:${port}/api/ws?token=old-lifetime-token` };
  } });
  const ask = askFor(host, book);
  const prepared = await ask('hermes-agent', L1);
  recordedPort = prepared.body.port;
  await ask('hermes-agent', L1, 'register', { port: prepared.body.port, pid: 5001 });
  const pending = ask('hermes-agent', L1);
  await entered.promise;
  host.endManaged(L1);
  host.startManaged({ agentId: 'hermes-agent', lifetime: L2, instance: 'default', harness: 'hermes', pid: 4322, launcher: 'C:/owned/hermes-aify', writtenAtUs: nowUs });
  held.resolve();
  const stale = await pending;
  assert.deepEqual([stale.status, stale.body.reason, stale.body.token], [409, 'not-current', undefined]);
});

test('CONTROL: an admission that still holds gets the live gateway', async (t) => {
  const aifyHome = home(t);
  const host = managed(aifyHome, [['hermes-agent', L1]]);
  let recordedPort;
  const book = new HermesGatewayBook({ ...safeDeps, aifyHome, processes: gatewayPid(() => recordedPort),
    probe: async ({ port }) => ({ port, token: 'own', wsUrl: `ws://127.0.0.1:${port}/api/ws?token=own` }) });
  const ask = askFor(host, book);
  const prepared = await ask('hermes-agent', L1);
  recordedPort = prepared.body.port;
  await ask('hermes-agent', L1, 'register', { port: prepared.body.port, pid: 5001 });
  const again = await ask('hermes-agent', L1);
  assert.deepEqual([again.status, again.body.live, again.body.token], [200, true, 'own']);
});
