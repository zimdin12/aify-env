#!/usr/bin/env node
// What other plugins add to a defined worker's environment, on each route main starts one by (aify-dashboard
// docs/PLAN-SECRETS-PORT-0.9.md, rev 2): A, a comms control `start`, admitted by main's own automaticStartAdmission
// through admitColdStart; B, a comms lifecycle request, through LifecycleSync, AgentLifecycle and its journal, and
// LifecycleLaunch. C, AgentLifecycle's own builder, stays refused, and the daemon's wiring is checked to keep it so.
// Contributors are fakes except where nothing fetched is the subject, which the real dashboard contributor answers.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { AgentLifecycle, LifecycleJournal } from "../lib/agent-lifecycle.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { automaticStartAdmission } from "../lib/plugins/aify-comms/automatic-start-admission.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { LifecycleLaunch } from "../lib/plugins/aify-comms/lifecycle-launch.mjs";
import { LifecycleSync } from "../lib/plugins/aify-comms/lifecycle-sync.mjs";
import { createOutputSender } from "../lib/plugins/aify-comms/output-sender.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { Runner } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const SECRETS = { project: "p1", names: ["OPENAI_API_KEY"] };
const agent = (over = {}) => Object.fromEntries(Object.entries({ name: "Lead", role: "coder", harness: "claude", mode: "managed",
  workspace: "C:/work", model: "", effort: "", instructions: "", env: {}, herdrSpace: true, secrets: SECRETS, ...over })
  .filter(([, value]) => value !== undefined));
const sentinel = () => `sentinel-${randomBytes(12).toString("hex")}`;

/** A fake contributor of `secrets`, recording what it was asked; `answer` may be a function of the request. */
function contributor(answer, asked = []) {
  return { service: "aify-dashboard", field: "secrets",
    async contribute(request) { asked.push(request); return typeof answer === "function" ? answer(request) : answer; } };
}

/**
 * One host: a definition store holding `lead`, the daemon's lifecycle ports over a journal, and a process table whose
 * start makes agent-state see the worker, as the managed host does. `running` starts it as already running.
 */
async function host({ over = {}, running = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-two-routes-"));
  const store = new DefinitionStore({ dir: path.join(root, "definitions"), lockWaitMs: 300 });
  await store.set("lead", agent(over), { installed: ALL });
  const { storeId } = await store.list();
  const aifyHome = path.join(root, "aify-home");
  fs.mkdirSync(aifyHome);
  new LifecycleJournal({ file: path.join(aifyHome, "agent-lifecycle.json") }).initialize({ priorBoot: false });
  let current = running ? { agentId: "lead", handle: "proc-0", pid: 999, lifetime: "L-0" } : null;
  const identity = () => ({ current, conflict: false, unknown: false });
  const starts = [];
  const processes = {
    async start(spec) { starts.push(spec); current = { agentId: "lead", handle: "proc-1", pid: 4242, lifetime: "L-1" }; return { id: "proc-1", pid: 4242, cols: 80, rows: 24 }; },
    async stop() { current = null; },
    subscribe() { return () => {}; },
    list() { return current ? [{ id: current.handle, pid: current.pid }] : []; },
  };
  const ports = createAgentLifecyclePorts({ aifyHome, machineId: "m", stateHost: { rawIdentity: identity, endManaged: () => {} },
    runner: processes, definitions: store, installed: async () => ALL, isAlive: () => false, settleMs: 0 });
  const logs = [];
  const shared = { windows: true, withinRoots: workspaceWithinRoots, resolveCandidates: () => ["C:/bin/claude-aify"],
    buildSpec: ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } }),
    baseEnv: { KEEP: "inherited" }, definitionFor: (launch) => store.boundReading(launch), log: (line) => logs.push(line) };
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: ["claude-aify", "--aify-agent", "lead"],
    cwd: "C:/work", env: {}, definition: { storeId, incarnation: 1, revision: 1 } };
  const journal = () => fs.readFileSync(path.join(aifyHome, "agent-lifecycle.json"), "utf8");
  return { root, store, storeId, ports, identity, processes, starts, logs, shared, launch, journal };
}

/** Route A: one comms control `start`, admitted by main's automaticStartAdmission over the daemon's ports. */
async function routeA(h, contributors) {
  const reports = [];
  const api = {
    async launch() { return { launch: h.launch }; },
    async reportControl(id, patch) { reports.push({ id, ...patch }); },
    async terminalOutput() { return {}; },
  };
  const result = await runOneControl({ ...h.shared, control: { id: "ctl-1", terminalId: "term-1", action: "start" }, api,
    processes: h.processes, handles: createHandleBook(), cwdRoots: ["C:/work"],
    admitStart: automaticStartAdmission({ definitions: h.store, agents: { ...h.ports, rawIdentity: h.identity } }),
    spawnEnv: () => contributors });
  return { result, reports, sent: reports.map((r) => JSON.stringify(r)) };
}

/** Route B: one comms lifecycle request, claimed by LifecycleSync and executed by the daemon's AgentLifecycle. */
async function routeB(h, contributors, { action = "start", expectedLifetime = null } = {}) {
  const request = { id: "req-1", agentId: "lead", machineId: "m", storeId: h.storeId, expectedIncarnation: 1,
    expectedRevision: 1, expectedLifetime, action, requestedBy: "operator" };
  const sent = [];
  const reported = [];
  const api = {
    async prepareLifecycleLaunch(...args) { sent.push(JSON.stringify(["prepare", ...args])); return { ok: true, launch: h.launch }; },
    async reportLifecycleAttachment(...args) { sent.push(JSON.stringify(["attachment", ...args])); return { ok: true, attachment: args[3] }; },
    async terminalOutput(...args) { sent.push(JSON.stringify(["output", ...args])); },
    async claimLifecycleRequests() { return { requests: [request] }; },
    async reportLifecycleRequest(...args) { sent.push(JSON.stringify(["report", ...args])); reported.push(args[3]); },
  };
  const adapter = new LifecycleLaunch({ ...h.shared, api, processes: h.processes, definitions: h.store, machineId: "m",
    handles: createHandleBook(), identity: h.identity, cwdRoots: async () => ["C:/work"], spawnEnv: () => contributors,
    sender: createOutputSender({ post: (id, body) => api.terminalOutput(id, body), status: "attached" }) });
  const sync = new LifecycleSync({ api, lifecycle: h.ports.lifecycle, machineId: "m", plugin: adapter });
  assert.equal((await sync.pass("e")).outcome, "synced", sync.state.lastError);
  return { result: reported[0], sent };
}

/** Every place a host keeps or sends something, besides the worker's own env. */
function places(h, run) {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full); else files.push([full, fs.readFileSync(full, "latin1")]);
  } };
  walk(h.root);
  return [...run.sent.map((s, i) => [`sent ${i}`, s]), ...h.logs.map((l, i) => [`log ${i}`, l]),
    ["result", JSON.stringify(run.result)], ...files];
}
const holding = (list, value) => list.filter(([, text]) => text.includes(value)).map(([label]) => label);

const ROUTES = { A: routeA, B: routeB };
const outcome = { A: (run) => run.result.outcome, B: (run) => run.result.status };
const why = { A: (run) => run.reports.at(-1).error, B: (run) => run.result.outcome };

for (const [name, route] of Object.entries(ROUTES)) {
  test(`ROUTE ${name}, HEALTHY: the contributed value is in the worker's env, and in no report, record, log or file`, async () => {
    const h = await host();
    const S = sentinel();
    const asked = [];
    const run = await route(h, [contributor({ env: { OPENAI_API_KEY: S } }, asked)]);
    assert.equal(outcome[name](run), name === "A" ? "started" : "done", JSON.stringify(run.result));
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].env.OPENAI_API_KEY, S, "the contribution reached the spec");
    assert.equal(h.starts[0].env.KEEP, "inherited", "laid over the daemon's env, not instead of it");
    assert.deepEqual(asked[0].definition.secrets, SECRETS, "asked with this host's definition");
    const where = places(h, run);
    assert.ok(where.some(([label]) => label.endsWith("agent-lifecycle.json")), "the journal is searched");
    assert.deepEqual(holding([["planted", `x${S}y`]], S), ["planted"], "the search finds a planted copy");
    assert.deepEqual(holding(where, S), []);
  });

  test(`ROUTE ${name}, NO SECRETS NAMED: the real dashboard contributor fetches nothing, and one naming a secret does`, async (t) => {
    // The bug (design test 3): a network call on every defined start. The host asks every contributor (spawn-env
    // 178-196, ported as approved); the dashboard's answers a definition naming no secrets without a request.
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      const match = /^\/api\/v1\/projects\/[^/]+\/secrets\/([^/]+)\/value$/.exec(request.url ?? "");
      response.writeHead(match ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(match ? { name: decodeURIComponent(match[1]), value: "v" } : { code: "not_found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const registry = new ServicePlugins();
    t.after(() => registry.stopAll());
    await registry.add(createDashboardPlugin({ endpoint, servedElsewhere: async () => true, service: { name: "aify-dashboard", endpoint } }, { tickMs: 60_000 }),
      new PluginHost({ processes: new PluginProcesses(new Runner({ openTerminal: () => null })), credential: async () => "fetch-key" }));
    const contributors = registry.capabilities("spawnEnv");
    const plain = await host({ over: { secrets: undefined } });
    const run = await route(plain, contributors);
    assert.equal(outcome[name](run), name === "A" ? "started" : "done", JSON.stringify(run.result));
    assert.deepEqual(requests, [], "nothing was fetched");
    // THE CONTROL, in the same run: the same contributor, on the same route, fetches for a definition naming one.
    const named = await host();
    const control = await route(named, contributors);
    assert.equal(outcome[name](control), name === "A" ? "started" : "done", JSON.stringify(control.result));
    assert.equal(requests.length, 1, "one request for the one secret named");
  });

  test(`ROUTE ${name}, A THROWING CONTRIBUTOR: the route's own record says refused in the host's words, nothing starts, nothing of it is kept`, async () => {
    const h = await host();
    const S = sentinel();
    const run = await route(h, [{ service: "aify-dashboard", field: "secrets", async contribute() { throw new Error(`boom ${S}`); } }]);
    assert.equal(outcome[name](run), "refused", JSON.stringify(run.result));
    assert.equal(why[name](run), "a plugin failed");
    assert.equal(h.starts.length, 0, "nothing was started");
    if (name === "B") assert.match(h.journal(), /"status":\s*"refused"[\s\S]*a plugin failed|a plugin failed[\s\S]*"status":\s*"refused"/, "the journal records it");
    assert.deepEqual(holding(places(h, run), S), []);
  });

  test(`ROUTE ${name}, THE BINDING: a hand edit while the contributions are asked refuses the start`, async () => {
    // The bug (D2): the binding checked before the network wait and not after, so a worker starts with the secrets of
    // a definition the operator has since changed. The edit lands inside the contributor, before it answers.
    const h = await host();
    const file = path.join(h.root, "definitions", "lead.json");
    const run = await route(h, [contributor(() => {
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      body.agent.secrets.project = "p2";
      fs.writeFileSync(file, JSON.stringify(body));
      return { env: { OPENAI_API_KEY: "s" } };
    })]);
    assert.equal(outcome[name](run), "refused", JSON.stringify(run.result));
    assert.match(why[name](run), /changed since this start was queued/);
    assert.equal(h.starts.length, 0);
  });
}

test("ROUTE B, RESTART: a refused contribution after the stop keeps the restart's already-stopped wording", async () => {
  // The whole-diff review of 0.9.2: a bare refusal reads as "left untouched" when the agent was in fact stopped.
  const h = await host({ running: true });
  const run = await routeB(h, [{ service: "aify-dashboard", field: "secrets", async contribute() { throw new Error("boom"); } }],
    { action: "restart", expectedLifetime: "L-0" });
  assert.equal(run.result.status, "refused", JSON.stringify(run.result));
  assert.equal(run.result.outcome, "stopped; not restarted: a plugin failed");
  assert.equal(h.identity().current, null, "the stop happened");
  assert.equal(h.starts.length, 0, "and no start");
});

test("ROUTE C STAYS REFUSED: the daemon's lifecycle ports supply no builder, and the default refuses before any start", async () => {
  // The negative production-wiring control (rev 2, C). The day bin wires a `buildSpec` into these ports, C becomes a
  // route that starts a defined worker without this boundary, and this fails.
  const source = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const at = source.indexOf("createAgentLifecyclePorts({");
  assert.ok(at > 0, "bin calls createAgentLifecyclePorts");
  let depth = 0;
  let end = at + "createAgentLifecyclePorts(".length;
  for (; end < source.length; end += 1) {
    if (source[end] === "{" || source[end] === "(") depth += 1;
    if (source[end] === "}" || source[end] === ")") depth -= 1;
    if (depth === 0) break;
  }
  const call = source.slice(at, end + 1);
  assert.match(call, /definitions: definitionStore/, "the extract is the call, which can be read for a key it holds");
  assert.doesNotMatch(call, /buildSpec/, "the daemon wires no builder into its lifecycle ports");
  assert.equal(source.split("createAgentLifecyclePorts(").length - 1, 1, "and nowhere else in bin");
  // What that default means: a start with no invocation is refused, and nothing is started.
  const h = await host();
  const request = { id: "req-c", agentId: "lead", machineId: "m", storeId: h.storeId, expectedIncarnation: 1,
    expectedRevision: 1, expectedLifetime: null, action: "start", requestedBy: "operator" };
  const answer = await h.ports.lifecycle.execute(request);
  assert.equal(answer.status, "refused");
  assert.equal(answer.outcome, "lifecycle-launch-composition-unavailable");
  assert.equal(h.starts.length, 0);
  assert.ok(h.ports.lifecycle instanceof AgentLifecycle);
});
