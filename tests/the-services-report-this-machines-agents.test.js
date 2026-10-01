#!/usr/bin/env node
// How `aify-env agents import` reaches every service (P0 C10): each plugin's `importable` capability,
// `ServicePlugins.capabilities()` handing out all of them, the daemon's `/agents/importable` route, and
// the client call the command makes. No daemon is started and no port is bound but a test's own.

import assert from "node:assert/strict";
import test from "node:test";

import { importableAgents } from "../lib/client-actions.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";
import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";

const deps = (extra = {}) => ({ runner: { list: () => [], stop: async () => {} }, readFile: () => "", version: "0.8.0", ...extra });
const ask = (extra) => handleRequest({ method: "GET", path: "/agents/importable" }, deps(extra));
const runner = { async start() { return { id: "p", pid: 1 }; }, subscribe() {}, canStream() { return true; }, write() {},
  resize() {}, async stop() {}, relabel() {}, release() {}, list() { return []; }, history() { return {}; }, instance() { return "i"; } };
const pluginHost = () => new PluginHost({ processes: new PluginProcesses(runner), environmentId: "", credential: async () => "", log: () => {} });
const store = (ids, unreadable = []) => ({ list: async () => ({ definitions: ids.map((id) => ({ id })), unreadable }) });

test("THE ROUTE asks every service, keeps one that failed as a report, and says what this host defines", async () => {
  const answer = await ask({
    agentServices: [
      { service: "aify-comms", importable: async () => ({ agents: [{ id: "lead" }], problem: "" }) },
      { service: "broken", importable: async () => { throw new Error("connect ECONNREFUSED"); } },
      { service: "starter-only" },
    ],
    definitions: store(["kept"], ["torn"]),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    services: [
      { service: "aify-comms", agents: [{ id: "lead" }], problem: "" },
      { service: "broken", agents: [], problem: "connect ECONNREFUSED" },
    ],
    defined: ["kept", "torn"], definedProblem: "", problem: "",
  });
});

test("NO SERVICE CAN REPORT: 503 with the reason; an unreadable store is said, not read as none defined", async () => {
  const none = await ask({ agentServices: [], definitions: store([]) });
  assert.deepEqual([none.status, none.body.problem, none.body.defined], [503, "no service plugin on this host can report its agents", []]);
  const locked = await ask({ agentServices: [], definitions: { list: async () => { throw new Error("the store is locked"); } } });
  assert.deepEqual([locked.body.defined, locked.body.definedProblem], [null, "the store is locked"]);
  const storeless = await ask({ agentServices: [] });
  assert.deepEqual([storeless.body.defined, storeless.body.definedProblem], [null, "this aify-env holds no definition store"]);
});

test("capabilities() hands out every started plugin's offer; capability() still hands out the first", async () => {
  const plugins = new ServicePlugins();
  const host = pluginHost();
  const offer = (service) => ({ name: service, capabilities: { agents: { service } }, start: async () => {}, stop: async () => {} });
  const broken = { ...offer("broken"), start: async () => { throw new Error("no credential"); } };
  for (const plugin of [offer("a"), { name: "none", start: async () => {}, stop: async () => {} }, broken, offer("b")]) plugins.register(plugin);
  await plugins.startAll(host);
  assert.deepEqual(plugins.capabilities("agents").map((c) => c.service), ["a", "b"], "a plugin that failed to start is not asked");
  assert.equal(plugins.capability("agents").service, "a");
  assert.deepEqual(plugins.capabilities(""), []);
});

test("THE CLIENT reads the report, and a daemon that does not answer is a problem, never an empty report", async () => {
  const body = { services: [{ service: "a", agents: [], problem: "" }], defined: ["x"], definedProblem: "", problem: "" };
  const answered = await importableAgents({ endpoint: "http://h/", fetchImpl: async (url) => {
    assert.equal(url, "http://h/agents/importable");
    return { ok: true, status: 200, json: async () => body };
  } });
  assert.deepEqual(answered, body);
  const down = await importableAgents({ endpoint: "http://h", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(down, { services: [], defined: null, definedProblem: "", problem: "the environment did not answer: ECONNREFUSED" });
});

test("THE aify-comms PLUGIN offers this machine's agents from its roster, and says so before it starts", async (t) => {
  const roster = { agents: { lead: { machineId: "win32:test-host", runtime: "claude-code", name: "Lead", role: "coder",
    sessionMode: "managed", cwd: "C:/w", model: "", instructions: "", herdrSpace: true, runtimeConfig: {} },
  other: { machineId: "win32:else", runtime: "codex" } } };
  const api = { identity: { bridgeId: "b" }, async heartbeat() { return {}; }, async claim() { return {}; },
    async claimControls() { return { controls: [] }; }, async agents() { return roster; } };
  const plugin = createCommsPlugin({ endpoint: "http://127.0.0.1:1", machineId: "win32:test-host", windows: true, api,
    advertisement: async () => ({ hostname: "test-host", kind: "win32" }), cwdRoots: async () => ["C:/w"],
    readFile: () => "", setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} });
  t.after(() => plugin.stop());
  const before = await plugin.capabilities.agents.importable();
  assert.deepEqual(before, { agents: [], problem: "the aify-comms plugin is not running on this host" });
  const host = pluginHost();
  await plugin.start(host);
  const answer = await plugin.capabilities.agents.importable();
  assert.deepEqual([answer.problem, answer.agents.map((r) => [r.id, r.agent.harness])], ["", [["lead", "claude"]]]);
});
