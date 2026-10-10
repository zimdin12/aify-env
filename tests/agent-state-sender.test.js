// Real G6 host/store/read/publisher composition. No listeners, agents or OS census.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { credentialForTarget } from "../lib/credential-resolve.mjs";
import { CredentialAclCache } from "../lib/credential-acl-cache.mjs";
import { readServices } from "../lib/services.mjs";
import { advertisementTargets } from "../lib/advertise.mjs";
import { pluginCredential } from "../lib/plugin-bootstrap.mjs";
import { CREDENTIAL_OK, CREDENTIAL_ABSENT } from "../lib/credential-store.mjs";

let AgentStateSender;
try { ({ AgentStateSender } = await import("../lib/agent-state-sender.mjs")); }
catch (e) { if (e.code !== "ERR_MODULE_NOT_FOUND") throw e; }
const L = "7f3c9e2a-0000-4000-8000-000000000001";
const M = "7f3c9e2a-0000-4000-8000-000000000002";
const AT = 1_790_950_000_600_000;
const inputs = { operatorStop: "tracked" };
const def = (mode) => ({ name: "Fixture", role: "coder", harness: "claude", mode, workspace: "C:/secret-workspace",
  model: "", effort: "", instructions: "secret-instructions", env: { SECRET: "secret-env" }, herdrSpace: true });
const target = (over = {}) => ({ endpoint: "http://fixture.invalid/mcp/sse", agentState: { path: "/api/v1/agent-state" }, ...over });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "native asynchronous work did not settle");
}
const response = (status = 204) => new Response(null, { status });
function envelope(body) {
  assert.deepEqual(body.inputs, inputs, `${body.kind} needs TOP-LEVEL inputs`);
  assert.equal(typeof body.inputs, "object"); assert.equal(Array.isArray(body.inputs), false);
  assert.ok(Object.values(body.inputs).every((value) => typeof value === "string"));
  assert.ok((body.agents ?? []).every((row) => !Object.hasOwn(row, "inputs")));
  assert.ok((body.removed ?? []).every((row) => typeof row.lifetime === "string" && row.lifetime.length > 0));
  assert.doesNotMatch(JSON.stringify(body), /secret|workspace|instructions|launcher|harness|createdAt|lifecycle|runsWith|screen|background/);
}
async function fixture(t, over = {}) {
  assert.equal(typeof AgentStateSender, "function", "AgentStateSender must own actual G6 observation-to-fetch dispatch");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "g7b-sender-"));
  const residents = path.join(home, "residents"); fs.mkdirSync(residents);
  let clock = 0, live = true, failProbe = false, harnessFailure = false, probes = 0, observations = 0;
  let harnessHold = null, registryFailure = false;
  let services = { x: target() };
  const resident = (lifetime = L) => fs.writeFileSync(path.join(residents, `lead.${lifetime}.json`), JSON.stringify({
    agentId: "lead", lifetime, instance: "default", harness: "claude", pid: 41,
    launcher: "C:/fixture/claude-aify", writtenAtUs: AT - 100 }));
  resident();
  const host = new AgentStateHost({ aifyHome: home, instance: "default", nowUs: () => AT + clock * 1000,
    probe: (pids) => { probes++; if (failProbe) throw new Error("secret-probe"); return new Map(pids.map((pid) => [pid,
      live ? { alive: true, createdAtUs: AT - 200, commandLine: "bash C:/fixture/claude-aify" } : { alive: false }])); } });
  host.boot();
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  for (const [id, mode] of [["lead", "resident"], ["ready", "managed"], ["offline", "resident"]]) {
    await definitions.set(id, def(mode), { installed: new Set(["claude"]) });
  }
  const calls = [], reports = [], timers = new Map(); let nextTimer = 0;
  const sender = new AgentStateSender({ identity: { machineId: "win32:fixture", instance: "default", generation: 10, incarnationId: "fixture-boot" },
    stateHost: host, definitions, lifecycle: { stopFacts: () => new Map() },
    observedHarnesses: async () => { observations++; if (harnessHold) await harnessHold.promise; if (harnessFailure) throw new Error("secret-harness"); return new Set(["claude"]); },
    readRegistry: () => { if (registryFailure) throw new Error("secret-registry"); return typeof services === "string" ? services : JSON.stringify({ version: 1, services }); },
    credentialOptions: () => ({ root: path.join(home, "credentials"), env: {} }),
    nowMs: () => clock, fetchImpl: async (url, options) => { const body = JSON.parse(options.body); envelope(body); calls.push({ url, options, body }); return response(); },
    setTimeoutImpl: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeoutImpl: (id) => timers.delete(id),
    report: (message) => reports.push(message), ...over });
  t.after(() => { sender.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const tick = async () => { await sender.tick(); await flush(); };
  return { home, host, definitions, sender, calls, reports, timers, resident, tick,
    time: (value) => { clock = value; }, services: (value) => { services = value; },
    live: (value) => { live = value; }, failProbe: (value) => { failProbe = value; },
    harnessFailure: (value) => { harnessFailure = value; }, hold: (value) => { harnessHold = value; },
    registryFailure: (value) => { registryFailure = value; }, observations: () => observations, probes: () => probes };
}

test("actual fetch resolves endpoint origin and sends complete available/offline/null G6 rows", async (t) => {
  const f = await fixture(t); await f.tick();
  assert.equal(f.calls.length, 1); const { body, url, options } = f.calls[0];
  assert.equal(url, "http://fixture.invalid/api/v1/agent-state", "not endpoint + route");
  assert.equal(body.kind, "snapshot");
  assert.deepEqual(body.agents.map((r) => [r.agentId, r.state, r.lifetime]), [["lead", "unknown", L], ["offline", "offline", null], ["ready", "available", null]]);
  envelope(body); assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
  assert.equal(options.headers["Content-Type"], "application/json");
  f.services({ x: target({ endpoint: "http://second.invalid/api/v1" }) }); await f.tick();
  assert.equal(f.calls[1].url, "http://second.invalid/api/v1/agent-state");
  assert.equal(f.calls[1].body.kind, "snapshot");
});

test("changes and partial-after-complete unavailable carry top-level inputs without losing the ACK view", async (t) => {
  const f = await fixture(t); await f.tick();
  f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 });
  await f.tick(); assert.equal(f.calls[1].body.kind, "changes"); envelope(f.calls[1].body);
  f.harnessFailure(true); await f.tick();
  assert.equal(f.calls[2].body.kind, "unavailable"); envelope(f.calls[2].body);
  assert.equal("agents" in f.calls[2].body, false); assert.equal("removed" in f.calls[2].body, false);
  f.harnessFailure(false); await f.tick(); assert.equal(f.calls.length, 3, "unavailable ACK cannot clear the complete view");
  f.failProbe(true); await f.tick(); assert.equal(f.calls[3].body.kind, "unavailable"); envelope(f.calls[3].body);
});

test("real token ending and recreation removes only actual selected tokens, never nullable definition rows", async (t) => {
  const f = await fixture(t); await f.tick(); f.live(false); await f.tick();
  assert.deepEqual(f.calls[1].body.removed, [{ agentId: "lead", lifetime: L }]);
  assert.equal(f.calls[1].body.agents[0].lifetime, null); envelope(f.calls[1].body);
  await f.definitions.remove("ready"); await f.tick();
  assert.equal(f.calls.length, 2, "no fabricated null removal");
  f.live(true); f.resident(M); await f.tick();
  assert.deepEqual(f.calls[2].body.agents.map((r) => r.lifetime), [M]);
  assert.deepEqual(f.calls[2].body.removed, []); envelope(f.calls[2].body);
});

test("initial, 59999 and 60000 quiet snapshots use boot epochs and changes cannot postpone them", async (t) => {
  const f = await fixture(t); await f.tick(); f.time(59_999); await f.tick(); assert.equal(f.calls.length, 1);
  f.time(60_000); await f.tick(); assert.equal(f.calls[1].body.kind, "snapshot");
  f.time(119_999); f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 });
  await f.tick(); assert.equal(f.calls[2].body.kind, "changes");
  f.time(120_000); await f.tick(); assert.equal(f.calls[3].body.kind, "snapshot");
  assert.deepEqual(f.calls.map((r) => r.body.publication), [1, 2, 3, 4]);
});

test("public ticks coalesce real collection and return before fetch settles; busy spends no number", async (t) => {
  const remote = defer(), f = await fixture(t, { fetchImpl: async (url, options) => { f.calls.push({ url, options, body: JSON.parse(options.body) }); return remote.promise; } });
  const observed = defer(); f.hold(observed);
  const a = f.sender.tick(), b = f.sender.tick(); assert.equal(a, b, "one collection promise");
  await flush(); assert.equal(f.observations(), 1); observed.resolve(); await a; await b; await flush();
  assert.equal(f.calls.length, 1, "tick did not await remote");
  await f.tick(); assert.equal(f.calls.length, 1);
  f.time(60_000); await f.tick(); assert.equal(f.calls.length, 1);
  remote.resolve(response()); await flush(); f.hold(null); await f.tick();
  assert.equal(f.calls[1].body.kind, "snapshot", "busy preserves overdue epoch");
  assert.equal(f.calls[1].body.publication, 2);
});

test("slow A does not block B and all target bodies share the publisher counter", async (t) => {
  const held = defer(), f = await fixture(t, { fetchImpl: async (url, options) => {
    f.calls.push({ url, options, body: JSON.parse(options.body) }); return url.includes("slow") ? held.promise : response(); } });
  f.services({ a: target({ endpoint: "http://slow.invalid/api/v1" }), b: target({ endpoint: "http://fast.invalid/mcp/sse" }) });
  await f.tick(); assert.deepEqual(f.calls.map((r) => r.body.publication), [1, 2]);
  f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 }); await f.tick();
  assert.equal(f.calls.length, 3); assert.match(f.calls[2].url, /fast/); assert.equal(f.calls[2].body.kind, "changes");
  assert.equal(f.calls[2].body.publication, 3); held.resolve(response()); await flush(); await f.tick();
  assert.match(f.calls[3].url, /slow/); assert.equal(f.calls[3].body.kind, "changes");
  assert.equal(f.calls[3].body.publication, 4);
});

test("physical aliases are occupied before deferred credentials and until actual fetch settlement", async (t) => {
  const key = defer(), remote = defer(); let resolving = 0;
  const f = await fixture(t, { credential: async (entry, options) => { resolving++; await key.promise; return credentialForTarget(entry, options); },
    fetchImpl: async (url, options) => { f.calls.push({ url, options, body: JSON.parse(options.body) }); return remote.promise; } });
  f.services({ a: target(), b: target({ endpoint: "http://fixture.invalid/api/v1" }) });
  await f.tick(); assert.equal(resolving, 1); assert.equal(f.calls.length, 0);
  await f.tick(); assert.equal(resolving, 1); key.resolve(); await flush(); await flush(); assert.equal(f.calls.length, 1);
  await f.tick(); assert.equal(f.calls.length, 1); remote.resolve(response()); await flush(); await f.tick();
  assert.equal(f.calls.length, 2, "alias B has its own initial snapshot");
  assert.equal(f.calls[1].body.kind, "snapshot"); assert.equal(f.calls[1].body.publication, 2);
});

test("repoint/remove/re-add retire slots, retain old physical occupancy and fence late ACK", async (t) => {
  const pending = [];
  const f = await fixture(t, { fetchImpl: async (url, options) => { const held = defer(); pending.push(held);
    f.calls.push({ url, options, body: JSON.parse(options.body) }); return held.promise; } });
  await f.tick(); f.services({ x: target({ endpoint: "http://new.invalid/api/v1" }) }); await f.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.signal.aborted, true);
  f.services({}); await f.tick(); const observed = f.observations();
  f.services({ x: target() }); await f.tick(); assert.equal(f.calls.length, 2, "abort request is not settlement");
  pending[0].resolve(response()); await flush(); await f.tick(); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].body.kind, "snapshot", "late old ACK cannot seed the replacement slot");
  pending[1].resolve(response()); await flush(); await f.tick(); assert.equal(f.calls.length, 3);
  assert.ok(f.observations() >= observed); pending[2].resolve(response()); await flush();
});

test("stop fences a delayed registry failure without logging or dispatching", async (t) => {
  const registry = defer(), f = await fixture(t, { readRegistry: () => registry.promise });
  const pending = f.sender.tick(); await flush(); f.sender.stop();
  registry.reject(new Error("secret-late-registry")); await pending; await flush();
  assert.deepEqual(f.reports, [], "late callbacks must be fenced after synchronous stop");
  assert.deepEqual(f.calls, []);
});

test("URL fragments cannot create overlapping physical-destination aliases", async (t) => {
  const held = defer(), f = await fixture(t, { fetchImpl: async (url, options) => {
    f.calls.push({ url, options, body: JSON.parse(options.body) }); return held.promise; } });
  f.services({ a: target({ agentState: { path: "/state#one" } }), b: target({ agentState: { path: "/state#two" } }) });
  await f.tick(); assert.equal(f.calls.length, 1, "fetch does not transmit fragment identifiers");
  await f.tick(); assert.equal(f.calls.length, 1);
  held.resolve(response()); await flush(); await f.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.kind, "snapshot");
});

test("retired deferred credentials cannot dispatch or seed a new target; stop fences ongoing collection", async (t) => {
  const key = defer(); let resolves = 0;
  const f = await fixture(t, { credential: async (entry, options) => {
    if (++resolves === 1) await key.promise; return credentialForTarget(entry, options); } });
  await f.tick(); assert.equal(f.calls.length, 0);
  f.services({ x: target({ endpoint: "http://new.invalid/api/v1" }) }); await f.tick();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /new\.invalid/);
  key.resolve(); await flush(); assert.equal(f.calls.length, 1);
  f.services({ x: target() }); await f.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.kind, "snapshot"); assert.equal(f.calls[1].body.publication, 2, "retired credential work spends no body number");
  const observation = defer(); f.hold(observation); const collecting = f.sender.tick(); await flush();
  const before = f.calls.length; f.sender.stop(); observation.resolve(); await collecting; await flush();
  assert.equal(f.calls.length, before, "stop cannot send a delayed observation");
});

test("failed or unreadable registry launches nothing and retains the ACK slot; successful no-target retires without collection", async (t) => {
  const f = await fixture(t); await f.tick(); const observations = f.observations();
  f.registryFailure(true); await f.tick(); f.registryFailure(false); f.services("{bad"); await f.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.observations(), observations);
  f.services({ x: target() }); await f.tick(); assert.equal(f.calls.length, 1, "registry failure did not retire acceptance");
  f.services({ x: { endpoint: "http://fixture.invalid", advertise: true } }); await f.tick();
  const before = f.observations(); await f.tick(); assert.equal(f.observations(), before);
  f.services({ x: target() }); await f.tick(); assert.equal(f.calls[1].body.kind, "snapshot");
});

test("only proven 204 adopts: 200 duplicate/stale/conflict, malformed and other 2xx do not ACK", async (t) => {
  for (const result of [new Response('{"applied":false,"reason":"duplicate"}', { status: 200 }),
    new Response('{"applied":false,"reason":"stale"}', { status: 200 }), new Response('{"applied":false,"reason":"conflict"}', { status: 200 }),
    response(201), response(202), { status: 204 }, { status: "204", ok: true }, { status: 204, ok: true, redirected: true }]) {
    const f = await fixture(t, { fetchImpl: async (url, options) => { f.calls.push({ url, options, body: JSON.parse(options.body) }); return result; } });
    await f.tick(); await f.tick(); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map((r) => r.body.kind), ["snapshot", "snapshot"]);
    assert.deepEqual(f.calls.map((r) => r.body.publication), [1, 2]);
  }
  const f = await fixture(t); await f.tick(); await f.tick(); assert.equal(f.calls.length, 1, "204 is the positive control");
});

test("failed changes drop without retry queue and next tick computes a new body against last ACK", async (t) => {
  let answer = response();
  const f = await fixture(t, { fetchImpl: async (url, options) => { f.calls.push({ url, options, body: JSON.parse(options.body) });
    if (answer instanceof Error) throw answer; return answer; } });
  await f.tick(); f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 });
  for (const fail of [response(503), new Error("secret-transport")]) {
    answer = fail; await f.tick(); const last = f.calls.at(-1); const count = f.calls.length;
    await flush(); await flush(); assert.equal(f.calls.length, count, "no automatic replay");
    answer = response(); await f.tick(); assert.equal(f.calls.at(-1).body.publication, last.body.publication + 1);
    assert.equal(f.calls.at(-1).body.kind, "changes");
    f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-end", firedAtUs: AT + count + 10 });
  }
  assert.doesNotMatch(f.reports.join(" "), /secret-transport/);
});

test("unproven success and unavailable do not renew a quiet epoch, and failed bodies are never replayed", async (t) => {
  let answer = response();
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    f.calls.push({ url, options, body: JSON.parse(options.body) }); return answer; } });
  await f.tick();
  f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 });
  answer = response(200); await f.tick(); assert.equal(f.calls[1].body.agents[0].state, "working");
  f.host.applyEvent({ agentId: "lead", lifetime: L, kind: "turn-end", firedAtUs: AT + 2 });
  answer = response(); await f.tick(); assert.equal(f.calls[2].body.agents[0].state, "idle", "fresh observation, not queued working body");
  assert.equal(f.calls[2].body.publication, 3);
  f.time(60_000); answer = response(202); await f.tick(); assert.equal(f.calls[3].body.kind, "snapshot");
  await f.tick(); assert.equal(f.calls[4].body.kind, "snapshot", "unproven success did not renew quiet lease");
  f.harnessFailure(true); answer = response(); await f.tick(); assert.equal(f.calls[5].body.kind, "unavailable"); envelope(f.calls[5].body);
  f.harnessFailure(false); await f.tick(); assert.equal(f.calls[6].body.kind, "snapshot", "unavailable 204 did not renew quiet lease");
  await f.tick(); assert.equal(f.calls.length, 7, "complete 204 is the positive quiet control");
});

test("timeout and synchronous stop request abort but occupancy and late ACK remain fenced until settlement", async (t) => {
  const held = defer(), second = defer(), f = await fixture(t, { fetchImpl: async (url, options) => {
    f.calls.push({ url, options, body: JSON.parse(options.body) }); return f.calls.length === 1 ? held.promise : second.promise; } });
  await f.tick(); for (const fn of f.timers.values()) fn();
  assert.equal(f.calls[0].options.signal.aborted, true); await f.tick(); assert.equal(f.calls.length, 1);
  held.reject(new Error("secret-timeout")); await flush(); await f.tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.publication, 2); f.sender.stop(); assert.equal(f.calls[1].options.signal.aborted, true);
  assert.equal(f.timers.size, 0, "stop must synchronously disarm owned timeout callbacks too");
  second.resolve(response()); await flush();
  await f.tick(); await flush(); assert.equal(f.calls.length, 2, "no final teardown publication");
  assert.doesNotMatch(f.reports.join(" "), /secret-timeout/);
});

test("invalid opt-ins fail closed without credential fallback or collection", async (t) => {
  let resolves = 0;
  const f = await fixture(t, { credential: async () => { resolves++; throw new Error("must not reach credentials"); } });
  for (const agentState of [null, [], false, "bad", {}, { path: "https://evil.invalid/state" }, { path: "//evil.invalid/state" },
    { path: "/\\evil.invalid/state" }, { path: "/state\n" }, { path: "/state", credentialRef: "" },
    { path: "/state", credentialRef: "../key" }, { path: "/state", credentialRef: null }, { path: "/state", extra: true }]) {
    f.services({ x: target({ agentState }) }); await f.tick();
  }
  assert.equal(resolves, 0); assert.equal(f.calls.length, 0); assert.equal(f.observations(), 0);
  for (const endpoint of ["file:///fixture", "http://user:secret@fixture.invalid/mcp/sse", "not-url"]) {
    f.services({ x: target({ endpoint }) }); await f.tick();
  }
  assert.equal(resolves, 0); assert.doesNotMatch(f.reports.join(" "), /secret|evil/);
});

test("named state ref ignores ordinary environment keys, rotates fresh bytes, and faults never fall back", async (t) => {
  const f = await fixture(t); const root = path.join(f.home, "credentials"); fs.mkdirSync(root);
  let aclReads = 0, secure = true;
  const acl = new CredentialAclCache({ now: () => 0, read: async (file) => {
    aclReads++; return `${file} fixture-owner:(F)\n${secure ? "" : "BUILTIN\\Users:(R)\n"}Successfully processed 1 files; Failed processing 0 files`; } });
  const opts = { root, env: { ORDINARY_KEY: "ordinary-secret-key" }, platform: "win32", owner: "fixture-owner", acl };
  f.sender.stop();
  const calls = [], reports = [];
  let services = { x: target({ keyEnv: ["ORDINARY_KEY"], credentialRef: "ordinary.key", agentState: { path: "/state", credentialRef: "state.key" } }) };
  const sender = new AgentStateSender({ identity: { machineId: "win32:fixture", instance: "default", generation: 10, incarnationId: "credentials" },
    stateHost: f.host, definitions: f.definitions, lifecycle: { stopFacts: () => new Map() }, observedHarnesses: () => new Set(["claude"]),
    readRegistry: () => JSON.stringify({ services }), credentialOptions: () => opts,
    fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return response(503); },
    report: (s) => reports.push(s) }); t.after(() => sender.stop());
  const tick = async () => { await sender.tick(); await until(() => calls.length > 0 || reports.length > 0); await flush(); };
  fs.writeFileSync(path.join(root, "state.key"), "state-secret-one\n"); await tick();
  assert.equal(calls.length, 1, reports.join(" "));
  assert.equal(calls[0].options.headers["x-aify-agent-state-key"], "state-secret-one");
  fs.writeFileSync(path.join(root, "state.key"), "state-secret-two\n");
  await sender.tick(); await until(() => calls.length >= 2); await flush();
  assert.equal(calls[1].options.headers["x-aify-agent-state-key"], "state-secret-two");
  assert.equal(calls[1].options.redirect, "error"); assert.ok(aclReads > 0, "existing ACL cache is used");
  fs.rmSync(path.join(root, "state.key")); await sender.tick(); await until(() => reports.some((s) => s.includes("CREDENTIAL_MISSING"))); await flush(); assert.equal(calls.length, 2);
  assert.match(reports.join(" "), /CREDENTIAL_MISSING/);
  secure = false; fs.writeFileSync(path.join(root, "state.key"), "state-secret-three\n");
  await sender.tick(); await until(() => reports.some((s) => s.includes("CREDENTIAL_INSECURE"))); await flush(); assert.equal(calls.length, 2); assert.match(reports.join(" "), /CREDENTIAL_INSECURE/);
  services = { x: target({ keyEnv: ["ORDINARY_KEY"], agentState: { path: "/state" } }) };
  await sender.tick(); await until(() => calls.length >= 3); await flush();
  assert.equal(calls[2].options.headers["x-aify-agent-state-key"], "ordinary-secret-key", "fallback only with absent state ref");
  assert.doesNotMatch(reports.join(" "), /secret|state\.key|ordinary\.key/);
});

// Pin the real registry -> advertised/plugin resolver -> sender path, not a fabricated credential result.
const credentialRows = [
  { name: "ordinary env-only", env: "ordinary-secret", state: CREDENTIAL_OK, source: "env", key: "ordinary-secret" },
  { name: "ordinary store-only", file: "ordinary-secret\n", state: CREDENTIAL_OK, source: "file", key: "ordinary-secret" },
  { name: "ordinary matching env and store", env: "ordinary-secret", file: "ordinary-secret\n", state: CREDENTIAL_OK, source: "env", key: "ordinary-secret" },
  { name: "ordinary conflicting env and store", env: "other-secret", file: "ordinary-secret\n", state: "CREDENTIAL_CONFLICT" },
  { name: "ordinary missing store with env", env: "ordinary-secret", file: null, state: "CREDENTIAL_MISSING" },
  { name: "ordinary invalid store with env", env: "ordinary-secret", file: "invalid-secret", state: "CREDENTIAL_INVALID" },
  { name: "ordinary insecure store with env", env: "ordinary-secret", file: "ordinary-secret\n", insecure: true, state: "CREDENTIAL_INSECURE" },
  { name: "ordinary unreadable store with env", env: "ordinary-secret", file: "ordinary-secret\n", unreadable: true, state: "CREDENTIAL_UNREADABLE" },
  { name: "ordinary invalid env", env: " invalid-secret", state: "CREDENTIAL_INVALID" },
  { name: "ordinary absent", state: CREDENTIAL_ABSENT },
  { name: "dedicated valid ignores ordinary key", env: "ordinary-secret", dedicated: "state-secret\n", state: CREDENTIAL_OK, key: "state-secret" },
  { name: "dedicated missing never falls back", env: "ordinary-secret", dedicated: null, state: "CREDENTIAL_MISSING" },
  { name: "dedicated invalid never falls back", env: "ordinary-secret", dedicated: "invalid-secret", state: "CREDENTIAL_INVALID" },
  { name: "dedicated insecure never falls back", env: "ordinary-secret", dedicated: "state-secret\n", insecure: true, state: "CREDENTIAL_INSECURE" },
  { name: "dedicated unreadable never falls back", env: "ordinary-secret", dedicated: "state-secret\n", unreadable: true, state: "CREDENTIAL_UNREADABLE" },
];
for (const row of credentialRows) test(`composed credential: ${row.name}`, async (t) => {
  let opts;
  const f = await fixture(t, { credentialOptions: () => opts });
  const root = path.join(f.home, "credentials"), named = Object.hasOwn(row, "dedicated");
  fs.mkdirSync(root);
  const ref = named ? "state.key" : "ordinary.key", bytes = named ? row.dedicated : row.file;
  const prepare = () => { if (typeof bytes === "string") fs.writeFileSync(path.join(root, ref), bytes); };
  prepare();
  const acl = new CredentialAclCache({ ttlMs: 0, read: async (file) => {
    // Real file-read failure after custody inspection, without native ACL/process side effects.
    if (row.unreadable) fs.rmSync(file);
    return `${file} fixture-owner:(F)\n${row.insecure ? "BUILTIN\\Users:(R)\n" : ""}Successfully processed 1 files; Failed processing 0 files`;
  } });
  opts = { root, env: row.env === undefined ? {} : { ORDINARY_KEY: row.env }, platform: "win32", owner: "fixture-owner", acl };
  const service = target({ keyEnv: ["ORDINARY_KEY"],
    ...(!named && Object.hasOwn(row, "file") ? { credentialRef: ref } : {}),
    agentState: { path: "/state", ...(named ? { credentialRef: ref } : {}) } });
  const text = JSON.stringify({ version: 1, services: { x: service } });
  const entry = readServices(text)[0], advertised = advertisementTargets([entry])[0];
  const ordinary = await credentialForTarget(advertised, opts);
  assert.equal(ordinary.state, named ? CREDENTIAL_OK : row.state);
  assert.equal(ordinary.source, named ? "env" : row.source ?? "");
  assert.equal(ordinary.value, named ? row.env : row.key ?? "");
  prepare(); assert.equal(await pluginCredential(entry, (target) => credentialForTarget(target, opts)), ordinary.value);
  prepare();
  f.services({ x: service }); await f.sender.tick();
  await until(() => f.calls.length > 0 || f.reports.length > 0); await flush();
  const sends = row.state === CREDENTIAL_OK || row.state === CREDENTIAL_ABSENT;
  assert.equal(f.calls.length, sends ? 1 : 0, f.reports.join(" "));
  if (sends) {
    assert.equal(f.calls[0].options.headers["x-aify-agent-state-key"], row.key);
    assert.equal(Object.hasOwn(f.calls[0].options.headers, "x-aify-agent-state-key"), row.state === CREDENTIAL_OK);
    assert.equal(f.calls[0].url, "http://fixture.invalid/state");
    assert.equal(f.calls[0].body.kind, "snapshot");
    assert.deepEqual(f.reports, []);
  } else assert.deepEqual(f.reports, [`agent state "x": ${row.state}`]);
  assert.doesNotMatch(f.reports.join(" "), /secret|ordinary\.key|state\.key/);
});
