// G6 exercises readAgentStates through the composed HTTP protocol. Only private homes and injected OS observations.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { handleRequest } from "../lib/protocol.mjs";
import { createDaemonHttp } from "../lib/daemon-http.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";

const L = "7f3c9e2a-0000-4000-8000-000000000001";
const M = "7f3c9e2a-0000-4000-8000-000000000002";
const AT = 1_790_950_000_600_000;
const marker = { operatorStop: "not-tracked" };
const agent = (mode = "resident") => ({ name: "Fixture", role: "coder", harness: "claude", mode, workspace: "C:/secret-workspace", model: "", effort: "", instructions: "secret-instructions", env: { SECRET: "secret-value" }, herdrSpace: true });
async function fixture(t, declared = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "g6-read-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "residents"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `lead.${L}.json`), JSON.stringify({ agentId: "lead", lifetime: L, instance: "default", harness: "claude", pid: 41, launcher: "C:/fixture/claude-aify", writtenAtUs: AT - 100 }));
  let probes = 0, failProbe = false, now = AT + 100;
  const host = new AgentStateHost({ aifyHome: home, instance: "default", nowUs: () => now,
    probe: (pids) => { probes++; if (failProbe) throw new Error("secret-probe"); return new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: AT - 200, commandLine: "bash C:/fixture/claude-aify" }])); } });
  host.boot();
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  if (declared) await definitions.set("lead", agent(), { installed: new Set(["claude"]) });
  const deps = { stateHost: host, definitions, observedHarnesses: () => new Set(["claude"]), turnEvents: new AgentTurnEvents({ host, instance: "default" }) };
  const get = async (over = {}) => {
    const result = await handleRequest({ method: "GET", path: "/agents/state" }, { ...deps, ...over });
    assert.notEqual(result.status, 404, "missing GET /agents/state route");
    assert.deepEqual(result.body.inputs, marker);
    return result;
  };
  return { home, dir, host, definitions, deps, get, probes: () => probes, fail: () => { failProbe = true; }, setNow: (value) => { now = value; } };
}

test("P-1 STATE READ publishes quiet verified work after hours and the admitted end", async (t) => {
  const f = await fixture(t);
  const start = await handleRequest({ method: "POST", path: "/agents/lead/turn-event", body: { instance: "default", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 } }, f.deps);
  assert.equal(start.body.applied, true);
  f.setNow(AT + 43_200_000_000);
  const result = await f.get();
  assert.equal(result.status, 200);
  const row = result.body.agents.find((a) => a.agentId === "lead");
  assert.equal(row.process.verified, "yes");
  assert.equal(row.busy, true, "HTTP projection must retain the selected no-age hold");
  assert.deepEqual([row.state, row.stateCause], ["working", "turn-open"]);
  assert.deepEqual(row.turn.busyIf, { strict: false, verifiedRenewal: true });
  assert.equal(row.turn.startedAtUs, AT + 1);
  assert.equal(row.turn.lastEventAtUs, AT + 1);
  const end = await handleRequest({ method: "POST", path: "/agents/lead/turn-event", body: { instance: "default", lifetime: L, kind: "turn-end", firedAtUs: AT + 43_200_000_000 } }, f.deps);
  assert.equal(end.body.applied, true);
  const ended = (await f.get()).body.agents.find((a) => a.agentId === "lead");
  assert.equal(ended.busy, false);
  assert.deepEqual([ended.state, ended.stateCause], ["idle", "at-prompt"]);
});

test("read cannot hide held adoption, admitted work, closed turn or managed and undeclared IDs", async (t) => {
  const f = await fixture(t); const before = f.probes();
  let r = await f.get(); assert.equal(r.status, 200); assert.equal(r.body.complete, true);
  assert.deepEqual([r.body.agents[0].state, r.body.agents[0].stateCause], ["unknown", "turn-unknown"]);
  assert.equal(f.probes(), before + 1, "read probes once");
  for (const [kind, at, state, cause] of [["turn-start", AT + 1, "working", "turn-open"], ["turn-end", AT + 2, "idle", "at-prompt"]]) {
    const hook = await handleRequest({ method: "POST", path: "/agents/lead/turn-event", body: { instance: "default", lifetime: L, kind, firedAtUs: at } }, f.deps);
    assert.equal(hook.body.applied, true);
    r = await f.get(); assert.deepEqual([r.body.agents[0].state, r.body.agents[0].stateCause], [state, cause]);
  }
  f.host.startManaged({ agentId: "worker", lifetime: M, instance: "default", pid: 42, handle: "fixture" });
  await f.definitions.set("worker", agent("managed"), { installed: new Set(["claude"]) });
  fs.writeFileSync(path.join(f.dir, `undeclared.${M}.json`), JSON.stringify({ agentId: "undeclared", lifetime: M, instance: "default", harness: "claude", pid: 43, launcher: "C:/fixture/claude-aify", writtenAtUs: AT - 100 }));
  r = await f.get(); assert.deepEqual(r.body.agents.map((a) => a.agentId), ["lead", "undeclared", "worker"]);
  assert.equal(r.body.agents[1].stateCause, "turn-unknown", "actual resident kind supplies mode without definition");
  assert.equal(r.body.agents[2].process.verified, "yes");
  assert.doesNotMatch(JSON.stringify(r.body), /secret|workspace|instructions|launcher/);
  const read = f.host.readAll(new Map([["lead", { definition: "valid", mode: "resident", stoppedByOperator: false }]]));
  read.agents[0].process.pid = 999; read.agents[0].turn.open = true;
  assert.equal(f.host.current("lead", { definition: "valid", mode: "resident", stoppedByOperator: false }).turn.open, false);
  assert.equal(f.host.current("lead").process.pid, 41);
});

test("definition read failure and suppressed launcher negatives cannot offer available or idle", async (t) => {
  const f = await fixture(t);
  await f.definitions.set("ready", agent("managed"), { installed: new Set(["claude"]) });
  let r = await f.get({ observedHarnesses: () => new Set() });
  assert.equal(r.body.complete, false); assert.ok(r.body.problems.includes("launcher-not-observed"));
  assert.ok(r.body.agents.every((a) => a.state === "unknown"));
  const failed = new DefinitionStore({ dir: path.join(f.home, "defs"), readdirSync: () => { throw Object.assign(new Error("secret-denial"), { code: "EACCES" }); } });
  assert.equal((await failed.list()).enumerationFailed, "EACCES", "list must not hide failed enumeration");
  for (const definitions of [failed, { list: async () => { throw new Error("secret-definition"); } }, { list: async () => ({ definitions: [], unreadable: ["unread"], conflict: { secret: "secret-conflict" } }) }]) {
    r = await f.get({ definitions }); assert.equal(r.body.complete, false); assert.ok(r.body.problems.length);
    assert.equal(r.body.agents.find((a) => a.agentId === "lead").state, "unknown");
    if (definitions !== failed && typeof definitions.list === "function" && r.body.problems.includes("definition-unreadable")) {
      assert.ok(r.body.agents.some((a) => a.agentId === "unread"), "unreadable definition ID remains enumerable");
      const unread = r.body.agents.find((a) => a.agentId === "unread");
      assert.deepEqual([unread.state, unread.stateCause], ["unknown", "unrecognised"]);
    }
    assert.doesNotMatch(JSON.stringify(r.body), /secret/);
  }
});

test("resident enumeration and corrupt records cannot become complete empty success", async (t) => {
  const f = await fixture(t);
  f.host.startManaged({ agentId: "worker", lifetime: M, instance: "default", pid: 42, handle: "fixture" });
  fs.writeFileSync(path.join(f.dir, `broken.${M}.json`), "not-json-secret");
  let r = await f.get(); assert.equal(r.body.complete, false);
  assert.equal(r.body.agents.find((a) => a.agentId === "broken").process.state, "unknown");
  assert.ok(r.body.problems.includes("resident-record-unreadable"));
  fs.rmSync(f.dir, { recursive: true }); fs.writeFileSync(f.dir, "secret-directory");
  r = await f.get(); assert.equal(r.body.complete, false); assert.ok(r.body.problems.includes("resident-enumeration-failed"));
  assert.equal(r.body.agents[0].process.state, "unknown");
  assert.deepEqual(r.body.agents.map((a) => a.agentId), ["lead", "worker"], "listing failure retains managed ID");
  assert.equal(r.body.agents[1].process.state, "unknown", "listing failure preserves host process-facts law even for managed");
});

test("undeclared resident identity survives failed listings without stale lifetime and clears on recovery", async (t) => {
  for (const earlierRead of [false, true]) {
    const f = await fixture(t, false);
    assert.equal(f.host.current("lead").process.verified, "yes", "boot observed the real private resident");
    if (earlierRead) assert.deepEqual((await f.get()).body.agents.map((a) => a.agentId), ["lead"]);
    fs.rmSync(f.dir, { recursive: true }); fs.writeFileSync(f.dir, "blocked-directory");
    for (let read = 0; read < 2; read++) {
      const r = await f.get();
      assert.equal(r.status, 200); assert.equal(r.body.complete, false);
      assert.ok(r.body.problems.includes("resident-enumeration-failed"));
      assert.deepEqual(r.body.agents.map((a) => a.agentId), ["lead"], "failed listing must retain undeclared resident row");
      const row = r.body.agents[0];
      assert.deepEqual([row.state, row.stateCause], ["unknown", "identity-unknown"]);
      assert.deepEqual(row.process, { state: "unknown", verified: "unknown", pid: null });
      assert.equal(row.lifetime, null); assert.equal(row.turn, null);
      const hook = await handleRequest({ method: "POST", path: "/agents/lead/turn-event", body: { instance: "default", lifetime: L, kind: "turn-start", firedAtUs: AT + 1 } }, f.deps);
      assert.equal(hook.body.applied, false, "retained identity does not admit a turn");
    }
    fs.rmSync(f.dir); fs.mkdirSync(f.dir);
    const recovered = await f.get(); assert.equal(recovered.body.complete, true); assert.deepEqual(recovered.body.agents, []);
    fs.rmSync(f.dir, { recursive: true }); const absent = await f.get(); assert.equal(absent.body.complete, true); assert.deepEqual(absent.body.agents, []);
    fs.writeFileSync(f.dir, "blocked-again"); assert.deepEqual((await f.get()).body.agents, [], "recovery cleared resident history");
  }
});

test("unavailable host or failed refresh never returns boot's stale success and always declares stop marker", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get({ stateHost: null })).status, 503);
  f.fail(); const r = await f.get(); assert.equal(r.status, 503); assert.deepEqual(r.body.agents, []); assert.equal(r.body.complete, false);
  assert.doesNotMatch(JSON.stringify(r.body), /secret/);
});

test("HTTP resolves boot host lazily and inherits wrong verb and browser refusal", async (t) => {
  const f = await fixture(t); let owner = null;
  const callback = createDaemonHttp({ runner: {}, traffic: { requests: 0, bytesOut: 0 }, protocolDeps: async () => ({ ...f.deps, stateHost: owner }) });
  const send = async (method = "GET", headers = {}) => {
    const request = Object.assign(new EventEmitter(), { method, url: "/agents/state", headers, async *[Symbol.asyncIterator]() {} });
    const response = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await callback(request, response); return response;
  };
  let r = await send(); assert.equal(r.status, 503); assert.deepEqual(r.body.inputs, marker);
  owner = f.host; r = await send(); assert.equal(r.status, 200); assert.deepEqual(r.body.inputs, marker);
  assert.equal((await send("POST")).status, 405);
  assert.equal((await send("GET", { origin: "https://fixture.invalid" })).status, 403);
});
