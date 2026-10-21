// SW5 R5: an agent this aify-env will not start reads `misconfigured`, never `available` (comms DECISIONS 0.9.2,
// "An agent its environment will not start reads misconfigured"). A managed workspace outside the folders the daemon was
// started in is refused at every start, so the published row says so. Private homes and injected OS observations only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleRequest } from "../lib/protocol.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { AgentStateSender } from "../lib/agent-state-sender.mjs";
import { CREDENTIAL_ABSENT } from "../lib/credential-store.mjs";

const M = "7f3c9e2a-0000-4000-8000-0000000000a1";
const AT = 1_790_950_000_600_000;
const ROOTS = ["C:/inside"];
const agent = (workspace, mode = "managed") => ({ name: "Fixture", role: "coder", harness: "claude", mode, workspace,
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true });

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "outside-roots-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "residents"));
  const host = new AgentStateHost({ aifyHome: home, instance: "default", nowUs: () => AT + 100,
    probe: (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: AT - 200, commandLine: "bash C:/fixture/claude-aify" }])) });
  host.boot();
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  const deps = { stateHost: host, definitions, observedHarnesses: () => new Set(["claude"]),
    lifecycle: { stopFacts: () => new Map() }, cwdRoots: ROOTS, windows: true };
  const row = async (id, over = {}) => {
    const result = await handleRequest({ method: "GET", path: "/agents/state" }, { ...deps, ...over });
    assert.equal(result.status, 200);
    return result.body.agents.find((a) => a.agentId === id);
  };
  return { host, definitions, row };
}

test("A MANAGED WORKSPACE OUTSIDE THE ROOTS publishes misconfigured, the reason being its definition is unavailable", async (t) => {
  const f = await fixture(t);
  await f.definitions.set("outsider", agent("C:/outside/work"), { installed: new Set(["claude"]) });
  const row = await f.row("outsider");
  assert.deepEqual([row.state, row.stateCause], ["misconfigured", "config"], "an agent every start refuses must not read available");
});

test("CONTROL: its twin inside the roots publishes available, and so does the outsider when no roots are known", async (t) => {
  const f = await fixture(t);
  await f.definitions.set("insider", agent("C:/inside/work"), { installed: new Set(["claude"]) });
  await f.definitions.set("outsider", agent("C:/outside/work"), { installed: new Set(["claude"]) });
  assert.equal((await f.row("insider")).state, "available");
  assert.equal((await f.row("outsider", { cwdRoots: null })).state, "available", "no roots, no judgement");
  assert.equal((await f.row("outsider", { cwdRoots: [] })).state, "available", "an empty root list judges nothing");
});

test("A RESIDENT outside the roots is not this host's to bound, and stays out of misconfigured", async (t) => {
  const f = await fixture(t);
  await f.definitions.set("hand", agent("C:/outside/work", "resident"), { installed: new Set(["claude"]) });
  assert.notEqual((await f.row("hand")).state, "misconfigured");
});

test("A RUNNING outside-roots process is not called misconfigured: one that may be running is the process rows' to judge", async (t) => {
  const f = await fixture(t);
  await f.definitions.set("outsider", agent("C:/outside/work"), { installed: new Set(["claude"]) });
  f.host.startManaged({ agentId: "outsider", lifetime: M, instance: "default", pid: 42, handle: "fixture" });
  const row = await f.row("outsider");
  assert.equal(row.process.state, "running");
  assert.notEqual(row.state, "misconfigured");
  assert.notEqual(row.state, "available");
});

test("THE SENDER publishes it: the daemon's roots reach the body every service receives", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "outside-roots-sender-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "residents"));
  const host = new AgentStateHost({ aifyHome: home, instance: "default", population: "managed", nowUs: () => AT + 100,
    probe: (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: AT - 200, commandLine: "bash C:/fixture/claude-aify" }])) });
  host.boot();
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  await definitions.set("outsider", agent("C:/outside/work"), { installed: new Set(["claude"]) });
  const sent = [];
  const sender = new AgentStateSender({ identity: { machineId: "win32:fixture", instance: "default", generation: 1 },
    stateHost: host, definitions, lifecycle: { stopFacts: () => new Map() }, observedHarnesses: async () => new Set(["claude"]),
    cwdRoots: ROOTS,
    readRegistry: async () => JSON.stringify({ version: 1, services: { x: { endpoint: "http://fixture.invalid/mcp/sse", agentState: { path: "/api/v1/agent-state" } } } }),
    credential: async () => ({ state: CREDENTIAL_ABSENT }), nowMs: () => 0, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
    fetchImpl: (_url, options) => { sent.push(JSON.parse(options.body)); return Promise.resolve(new Response(null, { status: 204 })); } });
  t.after(() => sender.stop());
  await sender.tick();
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  const row = sent.flatMap((body) => body.agents ?? []).find((a) => a.agentId === "outsider");
  assert.ok(row, `no row for the outsider was sent (${sent.length} bodies)`);
  assert.deepEqual([row.state, row.stateCause], ["misconfigured", "config"]);
});
