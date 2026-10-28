// Evaluate the real daemon bootstrap/cadence/cleanup statements. Never import the binding daemon.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { bootDaemonAgentState } from "../lib/daemon-agent-state.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
let AgentStateSender, REPORT_EVERY_MS;
try { ({ AgentStateSender, REPORT_EVERY_MS } = await import("../lib/agent-state-sender.mjs")); }
catch (e) { if (e.code !== "ERR_MODULE_NOT_FOUND") throw e; }
const source = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const RESIDENTS_KEY = /^residents-[0-9a-f]{12}$/;
const TIMER_PROBE_MS = 45_000;
/** The two populations compose concurrently and queue on the definition store, so the second post can lag a flush. */
async function posted(f, count) {
  for (const end = Date.now() + 5000; f.calls.length < count && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
}
function section(start, end) {
  const a = source.indexOf(start); assert.ok(a >= 0, `actual daemon is missing ${start}`);
  const b = source.indexOf(end, a); assert.ok(b > a, `actual daemon is missing ${end}`);
  return source.slice(a, b);
}
async function boot(t, { context = null, viewOnly = false, failBoot = false, failReady = false, failLifecycle = false } = {}) {
  assert.match(source, /import \{ AgentStateSender, REPORT_EVERY_MS \} from "\.\.\/lib\/agent-state-sender\.mjs"/, "daemon must wire the sender and its one cadence, not a test-only owner");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "g7b-daemon-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (failLifecycle) {
    fs.mkdirSync(path.join(home, ".aify"), { recursive: true });
    fs.writeFileSync(path.join(home, ".aify", "agent-lifecycle.json"), "invalid-json");
  }
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  const events = [], calls = [], intervals = [], cancelled = [];
  let lifecycle = null, shared = null, constructions = 0, lifecycleOwner = null;
  const setup = section("function evaluateAgentState()", "server.on(\"error\"");
  const body = section("server.listen(port, HOST, async () => {", "\nconst SWEEP_MS").replace(/^server\.listen\(port, HOST, async \(\) => \{/, "").replace(/\}\);\s*$/, "");
  const fakeProcess = { pid: 9, env: {}, execPath: "fixture-node", stdout: { write() {} }, stderr: { write() {} }, exit(code) { throw new Error(`exit-${code}`); } };
  const deps = {
    AgentStateSender: class extends AgentStateSender {
      constructor(options) { events.push("sender"); super({ ...options, fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) }); return new Response(null, { status: 204 }); } }); }
    },
    bootDaemonAgentState: (options) => { events.push("durable-boot"); if (failBoot) throw new Error("refused");
      return bootDaemonAgentState({ ...options, nowMs: 1000, nowUs: () => 1000000, pid: 9, probe: () => new Map() }); },
    publishInstanceReady: () => { events.push("ready"); if (failReady) throw new Error("refused"); },
    createAgentLifecyclePorts: (options) => {
      events.push("lifecycle"); constructions++;
      lifecycleOwner = options.owner;
      lifecycle = createAgentLifecyclePorts(options);
      return lifecycle;
    },
    AgentTurnEvents, server: { address: () => ({ port: 0 }) }, terminalSupport: () => ({ available: true }),
    join: path.join, homedir: () => home, HOST: "127.0.0.1", instanceContext: context,
    logLine: () => {}, definitionStore: definitions,
    reapLeftovers: async () => events.push("reap"), process: fakeProcess,
    startInputSocket: async () => null, HOST_CONFIG: { localSocket: false }, handleRequest: () => {}, runner: { instance: () => "fixture-runner" }, BUILD: "fixture-build",
    paneOpenerFor: () => null, fileURLToPath: () => "fixture-entry", startDaemonPlugins: async (options) => {
      shared = options.makeShared(); return null;
    },
    // No plugin started: the real ServicePlugins answers [] for any capability, and the state read asks it for screens.
    servicePlugins: { capabilities: () => [] }, resolvePluginCredential: () => {}, VERSION: "fixture", CWD_ROOTS: [],
    hostIdentityFacts: () => ({ machineId: "win32:fixture" }), hostname: () => "fixture", existsSync: () => false, hostIsWsl: () => false,
    installedHarnesses: () => [{ client: "claude" }], aifyLauncherFilesOnPath: () => [], currentAdvertisementBody: () => ({}), readGrantedRoots: () => [],
    readServices: () => [], pluginsForServices: () => {}, REGISTRY_FILE: "sealed-fixture",
    readFileSync: () => JSON.stringify({ services: { x: { endpoint: "http://fixture.invalid/mcp/sse", agentState: { path: "/state" } } } }),
    credentialReading: () => ({ env: {}, root: path.join(home, "credentials") }),
    startDaemonView: async () => ({ stop() {}, ownsScreen: false }), shutdown: () => {}, NOTICES: {}, NO_DASHBOARD: true,
    setInterval: (fn, ms) => { const timer = { fn, ms, unref() { this.unreferenced = true; } }; intervals.push(timer); return timer; },
    clearInterval: (id) => cancelled.push(id), viewOnly, stateSendingStopped: false,
    // Not the real cadence: the timer must take whatever the sender exports, so a restored literal reads 60_000 here.
    REPORT_EVERY_MS: TIMER_PROBE_MS,
  };
  // No import.meta value is needed by fake pane creation. Replace only that syntactic argument.
  const code = `let agentState=null, agentStateSender=null, stateEvaluationTimer=null, inputSocketServer=null, inputSocketAddress='', followServices=null, stopDashboard=()=>{}, dashboardOwnsScreen=false;
    ${setup}
    ${body.replaceAll("import.meta.url", "'fixture-module'")}
    return { sender:agentStateSender, evaluateAgentState, stopAgentStateSending, intervals: stateEvaluationTimer };`;
  let actual = null, error = null;
  try { actual = await new AsyncFunction(...Object.keys(deps), code)(...Object.values(deps)); }
  catch (e) { error = e; }
  t.after(() => actual?.stopAgentStateSending());
  await flush(); return { actual, error, events, calls, intervals, cancelled, lifecycle, shared, constructions,
    lifecycleOwner };
}

test("successful serving/durable boot wires actual sender and its exported evaluation cadence independent of sweep", async (t) => {
  const f = await boot(t); assert.equal(f.error, null, String(f.error));
  assert.equal(f.constructions, 1, "the actual daemon bootstrap must construct one lifecycle owner");
  assert.deepEqual(f.lifecycleOwner, { scope: 'http://127.0.0.1:0', generation: 1000, pid: 9, createdAtUs: null },
    "production ports must receive the boot owner's identity, not write ownerless reservations");
  assert.strictEqual(f.shared.agents.lifecycle, f.lifecycle.lifecycle, "plugins share the actual executor");
  assert.strictEqual(f.shared.agents.stopFacts, f.lifecycle.stopFacts, "plugins share the actual stop reader");
  assert.strictEqual(f.shared.agents.admitColdStart, f.lifecycle.admitColdStart);
  assert.equal(typeof f.shared.agents.rawIdentity, "function");
  // B1: a second sender, for the residents' key, because this daemon took the role for its private home at boot.
  await posted(f, 2);
  assert.deepEqual(f.events, ["durable-boot", "lifecycle", "reap", "sender", "sender"]);
  assert.deepEqual(f.calls.map((call) => call.body.instance).sort().map((i) => i.replace(RESIDENTS_KEY, "residents-*")),
    ["default", "residents-*"], "one publication per population, each under its own key");
  for (const call of f.calls) {
    assert.equal(call.url, "http://fixture.invalid/state");
    assert.equal(call.body.kind, "snapshot", "the sender reaches the real stop reader");
    assert.deepEqual(call.body.inputs, { operatorStop: "tracked" });
    assert.equal(call.body.build, "fixture-build", "B6: every population publishes the build this daemon loaded");
    assert.equal(call.body.reportEveryMs, REPORT_EVERY_MS, "decision 2: every population announces the sender's one cadence");
  }
  assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0].unreferenced, true);
  assert.equal(f.intervals[0].ms, TIMER_PROBE_MS, "decision 2: the evaluation timer takes the cadence the sender exports, no literal of its own");
  const sweep = section("const SWEEP_MS", "// ── telling"); let swept = 0, evaluated = 0;
  const run = new Function("process", "setInterval", "reaper", "evaluateAgentState", `let unknown; ${sweep}`);
  let sweepTimer;
  run({ env: { AIFY_SWEEP_MS: "177777" } }, (fn, ms) => { sweepTimer = { fn, ms, unref() {} }; return sweepTimer; },
    { sweep: () => { swept++; return { unknown: [] }; } }, () => evaluated++);
  assert.equal(sweepTimer.ms, 177777); sweepTimer.fn(); assert.equal(swept, 1, "existing sweep remains unconditional"); assert.equal(evaluated, 1);
  f.actual.stopAgentStateSending(); assert.equal(f.cancelled.length, 1);
  await f.intervals[0].fn(); await f.actual.evaluateAgentState(); await flush(); assert.equal(f.calls.length, 2, "captured callbacks are fenced after disarm");
  const stopView = /stopView: (\(\) => \{[^}]+\})/.exec(source); assert.ok(stopView, "shutdown must synchronously stop sending");
  const order = []; new Function("stopAgentStateSending", "stopDashboard", `return (${stopView[1]})()`)(() => order.push("sender"), () => order.push("view"));
  assert.deepEqual(order, ["sender", "view"]);
});

test("dedicated readiness precedes sending; boot/readiness refusal and view-only send nothing", async (t) => {
  const dedicated = await boot(t, { context: { scope: "fixture-scope" } });
  assert.equal(dedicated.error, null, String(dedicated.error)); await posted(dedicated, 2); assert.deepEqual(dedicated.events, ["durable-boot", "lifecycle", "ready", "sender", "sender"]);
  assert.equal(dedicated.lifecycleOwner.scope, 'fixture-scope');
  assert.deepEqual(dedicated.calls.map((call) => call.body.instance).sort().map((i) => i.replace(RESIDENTS_KEY, "residents-*")),
    ["fixture-scope", "residents-*"]);
  for (const options of [{ failBoot: true }, { context: { scope: "fixture-scope" }, failReady: true }, { viewOnly: true }]) {
    const f = await boot(t, options); assert.equal(f.calls.length, 0); assert.equal(f.intervals.length, 0);
    assert.equal(f.events.includes("sender"), false);
    if (!options.viewOnly) assert.match(String(f.error), /exit-2/); else assert.equal(f.error, null);
  }
  // A DAMAGED JOURNAL REFUSES LIFECYCLE ACTIONS, NOT THE HOST: it becomes ready and publishes that it cannot
  // read operator stops, rather than a state that silently forgets them.
  const damaged = await boot(t, { context: { scope: "fixture-scope" }, failLifecycle: true });
  assert.equal(damaged.error, null, String(damaged.error));
  await posted(damaged, 2);
  assert.deepEqual(damaged.events, ["durable-boot", "lifecycle", "ready", "sender", "sender"]);
  assert.deepEqual(damaged.calls.map((call) => call.body.kind), ["unavailable", "unavailable"]);
});
