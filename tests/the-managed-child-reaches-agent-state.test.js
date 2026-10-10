// G4 composition. Native child/network boundaries are denied by the external guarded lane.
// Runner constructs ManagedLifetimes. These cases check its consumed env and captured lifetime effects.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Runner } from "../lib/runner.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { buildStartSpec } from "../lib/start-spec.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";
import { runOneControl, createHandleBook } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { bootDaemonAgentState } from "../lib/daemon-agent-state.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { turnsFile } from "../lib/turns-file.mjs";

const AT = 1_790_950_000_600_000;
const TEXT = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\n';
const GIVEN = { definition: "valid", mode: "managed", stoppedByOperator: false };
const URL = "http://127.0.0.1:18802";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function fixture(t, { pipes = false, immediate = false, throws = false, checkpoint = null, ready = true, alive = false, missingPid = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "g4-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const probes = [], children = [], reports = [];
  const host = new AgentStateHost({ aifyHome: home, instance: "default", nowUs: () => AT + 1000,
    probe: (pids) => { probes.push(pids); return new Map(pids.map((pid) => [pid,
      { alive: true, createdAtUs: AT - 10, commandLine: "bash /fixture/claude-aify" }])); } });
  host.boot();
  let owner = ready ? { host, instance: "default", url: URL } : null;
  const spawn = (_command, _args, options) => {
    if (!children.length) assert.equal(host.current("lead", GIVEN).process.verified, "no", "no pre-spawn yes");
    if (throws) throw new Error("fake spawn failed");
    const child = new EventEmitter();
    Object.assign(child, { pid: missingPid ? undefined : 100 + children.length, cols: 80, rows: 24, env: options.env,
      stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} },
      onData() {}, onExit(fn) { child.finish = fn; if (immediate) fn({ exitCode: 0 }); },
      kill() {}, destroy() {}, write() {}, resize() {} });
    children.push(child);
    return child;
  };
  const runner = new Runner({ openTerminal: pipes ? null : spawn, spawnProcess: spawn, loadCheckpoint: checkpoint,
    managedHost: () => owner, reportManaged: (problem) => reports.push(problem),
    isAlive: () => alive, killTree: async () => {} });
  const receiver = new AgentTurnEvents({ host, instance: "default" });
  const send = (lifetime, at = AT + 1) => handleRequest({ method: "POST", path: "/agents/lead/turn-event",
    body: { instance: "default", lifetime, kind: "turn-start", firedAtUs: at } }, { turnEvents: receiver });
  const spec = (extra = {}) => buildStartSpec({ service: "fixture", launcher: "/fixture/claude-aify", agentId: "lead",
    env: { PATH: "toolchain", HERDR_PANE_ID: "daemon-pane", AIFY_LIFETIME: "stale", aify_env_instance: "wrong" }, ...extra },
  { readFile: () => TEXT, platform: "linux" }).spec;
  return { home, host, runner, children, probes, reports, send, spec,
    ready: () => { owner = { host, instance: "default", url: URL }; },
    file: turnsFile(home, "default"),
    end: (child, code = null) => pipes ? child.emit("close", code, "SIGTERM") : child.finish({ exitCode: code, signal: "SIGTERM" }) };
}

for (const pipes of [false, true]) test(`actual ${pipes ? "HTTP pipes" : "plugin PTY"} spawn reaches host and G3`, async (t) => {
  const f = fixture(t, { pipes });
  if (pipes) {
    const r = await handleRequest({ method: "POST", path: "/processes", body: { service: "fixture", launcher: "/fixture/claude-aify",
      env: { AIFY_AGENT_ID: "lead", AIFY_SESSION_MODE: "resident", AIFY_ENV_URL: "http://wrong", AIFY_LIFETIME: "stale" } } },
    { runner: f.runner, readFile: () => TEXT, platform: "linux" });
    assert.equal(r.status, 201);
  } else {
    const result = await runOneControl({ control: { id: "ctl", terminalId: "term", action: "start" },
      api: { launch: async () => ({ launch: { agentId: "lead", argv: ["claude-aify"], cwd: "/fixture", env: { AIFY_ENV_URL: "wrong" }, herdrSpace: false } }),
        reportControl: async () => {}, terminalOutput: async () => {} },
      processes: new PluginProcesses(f.runner, { prepare: () => { throw new Error("decoration"); } }),
      handles: createHandleBook(), cwdRoots: ["/fixture"], windows: false, withinRoots: () => true,
      resolveCandidates: () => ["/fixture/claude-aify"], baseEnv: { PATH: "toolchain", aify_lifetime: "alias", HERDR_PANE_ID: "daemon" },
      buildSpec: (input) => buildStartSpec(input, { readFile: () => TEXT, platform: "linux" }) });
    assert.equal(result.outcome, "started");
  }
  const env = f.children[0].env, token = env.AIFY_LIFETIME;
  assert.equal(env.AIFY_ENV_URL, URL, "host URL reaches consumed child env");
  assert.equal(env.AIFY_ENV_INSTANCE, "default", "state instance is not Runner UUID");
  assert.match(token, uuid, "fresh full lifetime UUID reaches child");
  assert.notEqual(token, f.runner.instance());
  assert.equal(Object.hasOwn(env, "aify_lifetime"), false);
  assert.equal(Object.hasOwn(env, "HERDR_PANE_ID"), false);
  assert.equal(f.host.current("lead", GIVEN).stateCause, "turn-unknown");
  assert.equal(f.host.current("lead", GIVEN).process.verified, "yes");
  assert.equal((await f.send(token)).body.applied, true, "refresh retains managed ownership for first G3 hook");
  assert.equal(JSON.parse(fs.readFileSync(f.file))[token].open, true);
  assert.deepEqual(f.probes, [], "managed PIDs never enter resident probe");
  f.end(f.children[0]);
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no", "observed exit ends ownership");
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.file)), token), false, "exit durably removes only its turn");
  assert.equal((await f.send(token, AT + 999)).body.reason, "not-current");
  assert.deepEqual(f.runner.list(), []);
});

test("checkpoint and failed creation never publish ownership; host absence and literal bad IDs refuse before spawn", async (t) => {
  const loaded = deferred(), release = deferred();
  const f = fixture(t, { checkpoint: async () => { loaded.resolve(); await release.promise; return null; } });
  const input = f.spec(), before = structuredClone(input);
  const pending = f.runner.start(input);
  await loaded.promise;
  assert.equal(f.children.length, 0);
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no");
  release.resolve(); await pending;
  assert.deepEqual(input, before, "caller spec is not mutated");
  const g = fixture(t, { throws: true });
  await assert.rejects(g.runner.start(g.spec()), /fake spawn failed/);
  assert.equal(g.host.current("lead", GIVEN).process.verified, "no");
  const h = fixture(t, { ready: false });
  await assert.rejects(h.runner.start(h.spec()), /managed.*unavailable/);
  assert.equal(h.children.length, 0);
  h.ready(); await h.runner.start(h.spec());
  for (const agentId of [" lead", "lead ", "", 3, "a/b"]) {
    const bad = fixture(t);
    await assert.rejects(bad.runner.start({ ...bad.spec(), agentId }), /agentId/);
    assert.equal(bad.children.length, 0);
  }
  const denied = fixture(t);
  await assert.rejects(denied.runner.start({ ...denied.spec(), fileText: "untrusted" }), /refused/);
  assert.equal(denied.children.length, 0);
});

test("bare HTTP never infers ambient or label identity; explicit builder identity survives env construction", async (t) => {
  const f = fixture(t, { pipes: true });
  const old = process.env.AIFY_AGENT_ID;
  process.env.AIFY_AGENT_ID = "lead";
  try {
    for (const env of [undefined, Object.create({ AIFY_AGENT_ID: "lead" })]) {
      const r = await handleRequest({ method: "POST", path: "/processes", body: { service: "fixture", launcher: "/fixture/claude-aify", label: "lead", env } },
        { runner: f.runner, readFile: () => TEXT, platform: "linux" });
      assert.equal(r.status, 201);
      assert.equal(f.children.at(-1).env?.AIFY_LIFETIME, undefined);
      assert.equal(f.host.current("lead", GIVEN).process.verified, "no");
      await handleRequest({ method: "POST", path: `/processes/${r.body.id}/label`, body: { label: "lead" } }, { runner: f.runner });
      assert.equal(f.host.current("lead", GIVEN).process.verified, "no");
    }
  } finally { if (old === undefined) delete process.env.AIFY_AGENT_ID; else process.env.AIFY_AGENT_ID = old; }
  assert.equal(f.spec().agentId, "lead", "builder preserves typed identity independently of env");
});

test("overlapping children conflict; exact release and delayed old exit preserve replacement turn", async (t) => {
  const f = fixture(t);
  const a = await f.runner.start(f.spec()), first = f.children[0].env.AIFY_LIFETIME;
  assert.equal((await f.send(first)).body.applied, true);
  const b = await f.runner.start(f.spec()), second = f.children[1].env.AIFY_LIFETIME;
  assert.notEqual(first, second);
  assert.equal((await f.send(second)).body.reason, "conflict", "latest spawn cannot win over live sibling");
  f.runner.release(a.id);
  assert.equal((await f.send(second, AT + 2)).body.applied, true);
  const before = fs.readFileSync(f.file, "utf8"), snapshot = f.host.current("lead", GIVEN);
  f.end(f.children[0]);
  assert.deepEqual(f.host.current("lead", GIVEN), snapshot, "late old callback does not end current lifetime");
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal((await f.send(first, AT + 999)).body.reason, "not-current");
  await f.runner.stop(b.id);
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no", "already-dead stop ends exact token");
});

test("stop request is not death; captured finish still ends after stream and registry release", async (t) => {
  const f = fixture(t, { alive: true });
  const a = await f.runner.start(f.spec()), token = f.children[0].env.AIFY_LIFETIME;
  assert.equal((await f.send(token)).body.applied, true);
  await f.runner.stop(a.id);
  assert.deepEqual(f.runner.list(), []);
  assert.equal(f.runner.canStream(a.id), false);
  assert.equal(f.host.current("lead", GIVEN).process.verified, "yes", "stop request is not observed death");
  f.end(f.children[0]);
  assert.equal(await a.exited, null);
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no", "captured finish survives released stream");
});

test("pipe creation without a PID never publishes yes", async (t) => {
  const f = fixture(t, { pipes: true, missingPid: true });
  const handle = await f.runner.start(f.spec());
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no", "missing PID is not successful child creation");
  f.children[0].emit("error", new Error("fake creation failure"));
  assert.equal(await handle.exited, -1);
  f.end(f.children[0]);
});

test("pipe error is not death; only later close ends its captured lifetime", async (t) => {
  const f = fixture(t, { pipes: true });
  const handle = await f.runner.start(f.spec()), token = f.children[0].env.AIFY_LIFETIME;
  assert.equal((await f.send(token)).body.applied, true, "healthy pipe starts a turn before the error");
  f.children[0].emit("error", new Error("fake refused operation on live child"));
  assert.equal(await handle.exited, -1, "ordinary Runner error completion is preserved");
  assert.equal(f.host.current("lead", GIVEN).process.verified, "yes", "pipe error is not observed death");
  assert.equal(JSON.parse(fs.readFileSync(f.file))[token].open, true);
  f.end(f.children[0]);
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no", "later close ends the exact lifetime");
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.file)), token), false);
});

test("immediate PTY exit and pipe error-close end once; durable exit failure does not abort Runner cleanup", async (t) => {
  const f = fixture(t, { immediate: true });
  const a = await f.runner.start(f.spec()); await a.exited;
  assert.equal(f.host.current("lead", GIVEN).process.verified, "no");
  const g = fixture(t, { pipes: true });
  const b = await g.runner.start(g.spec()), token = g.children[0].env.AIFY_LIFETIME;
  assert.equal((await g.send(token)).body.applied, true, "open turn before persistence fault");
  fs.rmSync(g.file); fs.mkdirSync(g.file);
  g.children[0].emit("error", new Error("fake async child error"));
  g.children[0].emit("close", 1, "");
  assert.equal(await b.exited, -1, "persistence failure cannot escape ordinary finish");
  assert.deepEqual(g.runner.list(), []);
  assert.equal(g.host.current("lead", GIVEN).process.verified, "no");
  assert.equal(g.reports.length, 1, "durable failure is reported once");
  g.children[0].emit("close", 1, "");
  assert.equal(g.reports.length, 1);
  const c = await g.runner.start(g.spec());
  assert.equal((await g.send(g.children[1].env.AIFY_LIFETIME, AT + 2)).body.reason, "persistence-failed", "failed end refuses later durable effects");
  assert.ok(c.id);
});

test("resident and managed facts share conflict selection; new owner does not adopt managed memory", async (t) => {
  const f = fixture(t);
  await f.runner.start(f.spec());
  const token = f.children[0].env.AIFY_LIFETIME;
  const resident = "7f3c9e2a-0000-4000-8000-000000000099";
  fs.mkdirSync(path.join(f.home, "residents"));
  const file = path.join(f.home, "residents", `lead.${resident}.json`);
  fs.writeFileSync(file, JSON.stringify({ agentId: "lead", lifetime: resident, instance: "foreign", harness: "claude", pid: 999,
    launcher: "/fixture/claude-aify", writtenAtUs: AT }));
  assert.equal((await f.send(token)).body.reason, "conflict");
  assert.deepEqual(f.probes, [[999]]);
  fs.rmSync(file);
  assert.equal((await f.send(token)).body.applied, true);
  const next = new AgentStateHost({ aifyHome: f.home, instance: "default", nowUs: () => AT + 1000, probe: () => new Map() });
  next.boot();
  assert.equal(next.current("lead", GIVEN).process.verified, "no");
});

test("actual daemon source statements lazily join boot host and bound URL for default and scoped instances", async (t) => {
  const source = fs.readFileSync(new globalThis.URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const runnerBlock = source.match(/const runner = new Runner\([\s\S]*?\n(?=\n\/\/ SERVICE PLUGINS)/)?.[0];
  const bootBlock = source.match(/  try \{ agentState = bootDaemonAgentState\([\s\S]*?\n  catch \(error\) \{[^\n]+\}/)?.[0];
  const depsBlock = source.match(/  protocolDeps: async \(\) => \([\s\S]*?\n  \),/)?.[0];
  assert.ok(runnerBlock && bootBlock && depsBlock, "unique actual bootstrap source boundaries");
  const stateLines = depsBlock.split("\n").filter((line) => /stateHost:|observedHarnesses:|lifecycle:/.test(line)).join("\n");
  assert.match(stateLines, /stateHost:/, "actual HTTP dependencies omit booted host");
  assert.match(stateLines, /observedHarnesses:/, "actual HTTP dependencies omit launcher observations");
  assert.match(stateLines, /lifecycle:/, "actual HTTP dependencies omit the lifecycle stop facts");
  for (const context of [null, { scope: "invocation-9" }]) {
    const f = fixture(t);
    const run = new Function("Runner", "bootDaemonAgentState", "AgentTurnEvents", "OWNED_FILE", "join", "homedir", "instanceContext", "HOST", "bound", "logLine", "process", "server",
      "createAgentLifecyclePorts", "hostIdentityFacts", "hostname", "existsSync", "hostIsWsl", "definitionStore",
      "installedHarnesses", "aifyLauncherFilesOnPath",
      `let agentState = null;\n${runnerBlock}\nconst readDeps = () => ({ ${stateLines} });\nif (readDeps().stateHost !== null) throw new Error("HTTP host captured before boot");\nif (typeof runner.deps.managedHost !== "function") throw new Error("actual bootstrap lacks lazy managedHost");\nconst before = () => runner.deps.managedHost();\nconst unready = before();\n${bootBlock}\nreturn { unready, owner: before(), http: readDeps() };`);
    class CaptureRunner { constructor(deps) { this.deps = deps; } }
    const observed = run(CaptureRunner,
      (args) => bootDaemonAgentState({ ...args, probe: () => new Map(), nowUs: () => AT, nowMs: AT / 1000 }),
      AgentTurnEvents, null, path.join, () => f.home, context, "127.0.0.1", { port: 18802 }, () => {},
      { stderr: { write() {} }, exit() { throw new Error("bootstrap failed"); }, platform: process.platform, env: {} },
      { address: () => ({ port: 18802 }) },
      createAgentLifecyclePorts, () => ({ machineId: "win32:test-host" }), () => "test-host", fs.existsSync, () => false,
      null, () => [], () => []);
    assert.equal(observed.unready, null);
    assert.equal(observed.owner.instance, context?.scope ?? "default");
    assert.equal(observed.owner.url, URL);
    assert.ok(observed.owner.host instanceof AgentStateHost);
    assert.equal(observed.http.stateHost, observed.owner.host, "HTTP resolves the actual booted host per request");
    const read = await handleRequest({ method: "GET", path: "/agents/state" }, observed.http);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.inputs, { operatorStop: "tracked" }, "the booted journal feeds the operator-stop input");
    assert.equal(read.body.complete, false, "missing supporting observations stay unresolved");
  }
});
