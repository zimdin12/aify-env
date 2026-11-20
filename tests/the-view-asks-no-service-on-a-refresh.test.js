// An open view asks no service anything on a refresh (env #30).
//
// THE OPERATOR SAW aify-env "constantly pinging". Read from source, an open TUI was the largest idle source on the
// host: every two seconds it knocked on each registered service's `/health` and asked the daemon for its picker and
// import rosters, each of which the comms plugin answers with a `GET /api/v1/agents`. Three comms requests and one
// dashboard request per refresh, with nobody looking at anything they answer.
//
// THE COUNT IS TAKEN THROUGH THE REAL PATHS: `startDashboard` -> `collectSnapshot` -> the daemon's own routes
// (`handleRequest`) -> the comms plugin's `AgentStarter` and `CommsApi`, down to a fake comms service that records
// every request it receives. Only the network is fake. On the base this file was written against, the first test
// counts 15 comms and 5 dashboard requests over five refreshes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { startDashboard } from "../lib/dashboard.mjs";
import { collectSnapshot } from "../lib/view-snapshot.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { serviceContactCheck } from "../lib/service-contacts.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { CommsApi } from "../lib/plugins/aify-comms/api.mjs";
import { AgentStarter } from "../lib/plugins/aify-comms/agent-starter.mjs";
import { importRecords } from "../lib/plugins/aify-comms/agent-import-records.mjs";
import { listStartableAgents } from "../lib/client-actions.mjs";
import { readLayout } from "../lib/tui-layout.mjs";

const DAEMON = "http://127.0.0.1:8802";
const COMMS = "http://127.0.0.1:8800";
const DASHBOARD = "http://127.0.0.1:9700";
const OTHER = "http://127.0.0.1:9999";
const NOW = 1_700_000_000_000;
const MACHINE = "win32:fixture";
const DETACH = String.fromCharCode(29);
const REGISTRY = JSON.stringify({ services: {
  "aify-comms": { endpoint: COMMS }, "aify-dashboard": { endpoint: DASHBOARD }, "other-svc": { endpoint: OTHER },
} });

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });

/**
 * A daemon whose routes are the real ones, a comms plugin capability built from the real starter and client, and
 * three services that record what reaches them. `state.revision` and `state.contacts` are what `/health` says.
 */
function world({ contacts = [], revision = "r1" } = {}) {
  const state = { contacts, revision };
  const sent = { daemon: [], comms: [], dashboard: [], other: [] };
  const rosterReads = () => sent.comms.filter((url) => url.endsWith("/api/v1/agents")).length;
  const commsFetch = async (url) => {
    sent.comms.push(String(url));
    // A RUNAWAY READ LOOP IS STALLED, not left to fill the heap: past this many roster reads the fake stops answering,
    // so the view's timers still run and the test reports the count it saw instead of dying.
    if (rosterReads() > 20) return new Promise(() => {});
    return reply(200, String(url).endsWith("/api/v1/agents") ? { agents: {} } : { status: "healthy" });
  };
  const api = new CommsApi({ endpoint: COMMS, credential: async () => "", identity: { bridgeId: "fixture" }, fetchImpl: commsFetch });
  const starter = new AgentStarter({ api, machineId: MACHINE });
  // THE PLUGIN'S CAPABILITY SHAPE (lib/plugins/aify-comms/index.mjs): one object the daemon reaches by capability.
  const capability = {
    service: "aify-comms",
    list: () => starter.list(),
    start: async () => ({ started: false, problem: "not in this test" }),
    importable: async () => ({ agents: importRecords(await api.agents(), MACHINE), problem: "" }),
  };
  const deps = { agents: capability, agentServices: [capability], definitions: null };
  const health = () => ({
    status: "healthy", version: "0.9.12-dev", build: "fixture", processes: [], unknown: [],
    terminals: { available: true, reason: "" }, plugins: [{ service: "aify-comms", claiming: true }],
    history: { startedTotal: 0, lastExitAtMs: null }, serviceContacts: state.contacts, rosterRevision: state.revision,
  });
  const fetchImpl = async (raw) => {
    const url = String(raw);
    if (url.startsWith(COMMS)) return commsFetch(url);
    if (url.startsWith(DASHBOARD)) { sent.dashboard.push(url); return reply(200, { status: "healthy" }); }
    if (url.startsWith(OTHER)) { sent.other.push(url); return reply(200, { status: "healthy" }); }
    sent.daemon.push(url);
    const path = new URL(url).pathname;
    if (path === "/health") return reply(200, health());
    if (path === "/agents/state") return reply(200, { agents: [] });
    const answer = await handleRequest({ method: "GET", path }, deps);
    return reply(answer.status, answer.body);
  };
  const healthReads = () => sent.daemon.filter((url) => url === `${DAEMON}/health`).length;
  return { state, sent, fetchImpl, rosterReads, healthReads };
}

/** What every view here is given, sealed from this host: registry, credentials, definitions, clock and layout. */
function sealed(w, extra = {}) {
  return {
    endpoint: DAEMON, registryPath: "unused", readFile: () => REGISTRY, fetchImpl: w.fetchImpl,
    readCredentialStore: async () => ({ names: [] }), readInvocationRegistries: () => [], readDefinitions: () => new Map(),
    nowMs: () => NOW, write: () => {}, clearScreen: false, columns: 240, rows: 60,
    processEvents: new EventEmitter(),
    layout: readLayout({ readFile: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); } }),
    ...extra,
  };
}

/** Wait until `done()` holds; refreshes here run on a short interval, so a condition is reached, not a time. */
async function until(done, what) {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(done(), `never happened: ${what}`);
}

test("five refreshes with the start list closed send nothing to any service", async () => {
  const w = world();
  for (let i = 0; i < 5; i++) await startDashboard(sealed(w, { once: true }));
  assert.equal(w.healthReads(), 5, "CONTROL: each refresh asked the daemon's own /health");
  assert.deepEqual({ comms: w.sent.comms, dashboard: w.sent.dashboard, other: w.sent.other },
    { comms: [], dashboard: [], other: [] });
});

test("a failed comms beat is on the screen, and nothing asked comms for it", async () => {
  const w = world({ contacts: [
    { name: "aify-comms", endpoint: COMMS, channel: "heartbeat", at: NOW - 12_000, ok: false, error: "401: key refused" },
    { name: "aify-dashboard", endpoint: `${DASHBOARD}/`, channel: "provider wait", at: new Date(NOW - 3_000).toISOString(), ok: true, error: "" },
  ] });
  const frames = [];
  await startDashboard(sealed(w, { once: true, write: (text) => frames.push(text) }));
  const screen = frames.join("");
  assert.match(screen, /heartbeat failed 12s ago: 401: key refused/);
  assert.match(screen, /provider wait ok 3s ago/);
  assert.match(screen, /unobserved: nothing on this host contacts http:\/\/127\.0\.0\.1:9999; run `aify-env doctor`/);
  const snapshot = await collectSnapshot(sealed(w));
  assert.deepEqual(Object.fromEntries(snapshot.services.map((s) => [s.name, s.state])),
    { "aify-comms": "failed", "aify-dashboard": "passed", "other-svc": "unanswered" });
  assert.deepEqual({ comms: w.sent.comms, dashboard: w.sent.dashboard, other: w.sent.other },
    { comms: [], dashboard: [], other: [] });
});

test("the start list reads the roster on opening, and again only when the roster moves while it is open", async (t) => {
  const w = world();
  const input = new FakeInput();
  // THE CLIENT'S OWN REQUEST (`aify-env tui`), through the daemon's route to the plugin's starter.
  const view = await startDashboard(sealed(w, { input, intervalMs: 3,
    onStartList: () => listStartableAgents({ endpoint: DAEMON, fetchImpl: w.fetchImpl }) }));
  t.after(() => view.stop());
  const refreshesAfter = async (n) => { const from = w.healthReads(); await until(() => w.healthReads() >= from + n, `${n} refreshes`); };

  await refreshesAfter(3);
  assert.equal(w.rosterReads(), 0, "a closed list read the roster");
  input.emit("data", "s");
  await until(() => w.rosterReads() >= 1, "the opening read");
  await refreshesAfter(3);
  assert.equal(w.rosterReads(), 1, "refreshes under an unchanged roster read it again");
  w.state.revision = "r2";
  await until(() => w.rosterReads() >= 2, "a read for the moved roster");
  await refreshesAfter(3);
  assert.equal(w.rosterReads(), 2, "one moved roster was read more than once");
  input.emit("data", DETACH);
  w.state.revision = "r3";
  await refreshesAfter(3);
  assert.equal(w.rosterReads(), 2, "a closed list was read for a moved roster");
  input.emit("data", "s");
  await until(() => w.rosterReads() >= 3, "the reopening read");
  await refreshesAfter(2);
  assert.equal(w.rosterReads(), 3, "reopening read the roster more than once");
  assert.equal(w.sent.dashboard.length + w.sent.other.length, 0);
});

test("an answer overtaken by a later read never fills the list", async (t) => {
  const w = world();
  const input = new FakeInput();
  const asks = [];
  const started = [];
  const view = await startDashboard(sealed(w, { input, intervalMs: 3,
    onStartList: () => new Promise((resolve) => { asks.push(resolve); }),
    onStartAgent: async (agent) => { started.push(agent.id); return { started: true }; } }));
  t.after(() => view.stop());
  input.emit("data", "s");
  assert.equal(asks.length, 1, "CONTROL: opening asked");
  w.state.revision = "r2";
  await until(() => asks.length === 2, "a second read for the moved roster");
  asks[1]({ agents: [{ id: "fresh", name: "fresh" }] });
  asks[0]({ agents: [{ id: "stale", name: "stale" }] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.emit("data", "\r");
  await until(() => started.length > 0, "a start from the list");
  assert.deepEqual(started, ["fresh"]);
});

test("CONTROL: the doctor still asks every service and both rosters", async () => {
  const asked = [];
  await collectEnvironmentChecks({
    endpoint: DAEMON,
    knock: async (url) => { asked.push(url); return url === `${DAEMON}/health`
      ? { ok: true, status: 200, body: { processes: [], terminals: {} } } : { ok: false, error: "fixture" }; },
    readRegistry: () => ({ text: REGISTRY }),
    terminalSupport: () => ({ available: true, reason: "" }),
    readCredentialStore: async () => ({ names: [] }),
  });
  for (const url of [`${DAEMON}/agents/startable`, `${DAEMON}/agents/importable`, `${COMMS}/health`, `${DASHBOARD}/health`, `${OTHER}/health`]) {
    assert.ok(asked.includes(url), `the doctor no longer asks ${url}: ${asked}`);
  }
});

test("a service row says which kind of unknown it is", () => {
  const entry = { name: "aify-comms", endpoint: COMMS };
  assert.match(serviceContactCheck(entry, { answered: false }, NOW).detail, /no aify-env answered/);
  assert.match(serviceContactCheck(entry, { answered: true, contacts: undefined }, NOW).detail,
    /does not report what it heard/);
  const elsewhere = serviceContactCheck(entry, { answered: true, contacts: [
    { name: "aify-comms", endpoint: "http://127.0.0.1:1", channel: "heartbeat", at: NOW, ok: true },
  ] }, NOW);
  assert.equal(elsewhere.state, "unanswered", "a contact with another endpoint was read as this one");
  assert.match(elsewhere.detail, /unobserved/);
});
