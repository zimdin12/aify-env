// Terminal controls: the half that makes this host the process host.
//
// WHAT THIS CLOSES, measured on real hardware 2026-09-03. Six spawns were claimed by this plugin
// within seconds and none of them ever ran, because starting a worker was the aify-comms BRIDGE's
// job and nothing here did it. Claiming registers a WARM agent; the process comes later, when the
// service asks for it — and asking is a terminal control.
//
// THE SPLIT THESE ASSERT. The service sends the program, its `argv` and the aify-owned environment;
// this host adds only what the service cannot know — its own environment, and which FILE on this
// machine that program name refers to. A second implementation of "what does a claude worker need"
// living here is exactly what the plugin seam exists to prevent.
//
// EVERY CLAIMED CONTROL IS REPORTED, on every path. A control the service never hears about again is
// one it hands to nobody else: the dashboard shows a terminal that is neither running nor failed and
// the agent waits for ever. That is this tier's most repeated failure, so it is asserted as a
// property over all outcomes rather than trusted per test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runOneControl, runTerminalControlPass } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";

const ROOTS = ["C:/work"];
const LAUNCH = {
  terminalId: "term-1",
  agentId: "sc-lead",
  runtime: "claude-code",
  command: "claude-aify --aify-agent sc-lead",
  argv: ["claude-aify", "--aify-agent", "sc-lead"],
  cwd: "C:/work",
  env: { AIFY_AGENT_ID: "sc-lead", AIFY_AGENT_ROLE: "tester", AIFY_SESSION_MODE: "managed" },
};

function fakeApi({ controls = [], launch = LAUNCH, claimThrows = null, launchThrows = null } = {}) {
  const reports = [];
  let handedOut = false;
  return {
    reports,
    async claimControls() {
      if (claimThrows) throw new Error(claimThrows);
      if (handedOut) return { controls: [] };
      handedOut = true;
      return { controls };
    },
    async launch() {
      if (launchThrows) throw new Error(launchThrows);
      return { launch };
    },
    async reportControl(id, patch) { reports.push({ id, ...patch }); },
  };
}

function fakeProcesses({ startThrows = null } = {}) {
  const calls = { starts: [], writes: [], resizes: [], stops: [] };
  return {
    calls,
    async start(spec) {
      calls.starts.push(spec);
      if (startThrows) throw new Error(startThrows);
      return { id: "proc-1", pid: 4242 };
    },
    write(id, data) { calls.writes.push({ id, data }); },
    resize(id, cols, rows) { calls.resizes.push({ id, cols, rows }); },
    async stop(id) { calls.stops.push(id); },
  };
}

/** The allowlist stands in as "accepts the second candidate", which is the Windows shape: the shim
 *  resolves first and is refused, the launcher beside it is accepted. */
const buildSpec = ({ launcher, args, cwd, env, label }) => (
  launcher.endsWith(".cmd")
    ? { error: { status: 403, detail: `refused ${launcher}: no wrapper marker` } }
    : { spec: { launcher, args, cwd, env, label, fileText: "#!/usr/bin/env bash" } }
);
const resolveTo = (...paths) => () => paths;

const control = (over = {}) => ({ id: "ctl-1", terminalId: "term-1", action: "start", ...over });

function run(over = {}) {
  const api = over.api || fakeApi();
  const processes = over.processes || fakeProcesses();
  return runOneControl({
    control: over.control || control(),
    api,
    processes,
    cwdRoots: ROOTS,
    windows: true,
    withinRoots: workspaceWithinRoots,
    buildSpec: over.buildSpec || buildSpec,
    resolveCandidates: over.resolveCandidates || resolveTo("C:/bin/claude-aify"),
    baseEnv: over.baseEnv || { PATH: "C:/bin", AIFY_AGENT_ROLE: "coder" },
  }).then((result) => ({ result, api, processes }));
}

test("a start control RUNS what the service asked for, with its argv", async () => {
  const { result, processes } = await run();
  assert.equal(result.outcome, "started");
  const spec = processes.calls.starts[0];
  assert.equal(spec.launcher, "C:/bin/claude-aify");
  assert.deepEqual(spec.args, ["--aify-agent", "sc-lead"]);
  assert.equal(spec.cwd, "C:/work");
  assert.equal(spec.id, "term-1");
});

test("THE SERVICE'S ENVIRONMENT WINS OVER AN INHERITED ONE", async () => {
  // The bug class the overlay exists to close, asserted in the direction that fails silently: this
  // host's own environment carries AIFY_AGENT_ROLE=coder, the spawn chose `tester`. Merging the
  // other way round produces a worker that self-registers as a coder — ask for a tester, get a
  // coder, with nothing reporting a problem.
  const { processes } = await run();
  const env = processes.calls.starts[0].env;
  assert.equal(env.AIFY_AGENT_ROLE, "tester", "an inherited value beat the one the spawn chose");
  assert.equal(env.PATH, "C:/bin", "and the host's own environment must still be there");
});

test("the SHIM is refused and the launcher beside it is used", async () => {
  // THE WINDOWS DEFECT, end to end. Resolving `claude-aify` yields the .cmd shim first; the
  // allowlist refuses it; the extensionless sibling is what actually runs. On Linux there is one
  // path and this is inert, which is why the seam was proven for weeks without seeing it.
  const { result, processes } = await run({
    resolveCandidates: resolveTo("C:/bin/claude-aify.cmd", "C:/bin/claude-aify"),
  });
  assert.equal(result.outcome, "started");
  assert.equal(processes.calls.starts[0].launcher, "C:/bin/claude-aify");
});

test("when NO candidate is accepted, every file it looked at is named", async () => {
  // "The agent did not start" is what this used to be, minutes later, with each candidate's own
  // reason discarded — and the reasons differ: "cannot read" and "refused by the allowlist" send an
  // operator to two different places.
  const { result, api } = await run({ resolveCandidates: resolveTo("C:/bin/claude-aify.cmd") });
  assert.equal(result.outcome, "refused");
  assert.match(result.detail, /claude-aify\.cmd/);
  assert.match(result.detail, /no wrapper marker/);
  assert.equal(api.reports[0].status, "failed");
});

test("a command that resolves to nothing is refused, and says so", async () => {
  const { result } = await run({ resolveCandidates: resolveTo() });
  assert.equal(result.outcome, "refused");
  assert.match(result.detail, /does not resolve to a file on this host/);
});

test("A WORKSPACE OUTSIDE THE ADVERTISED ROOTS IS REFUSED, and nothing starts", async () => {
  // The riskiest step in the pass: this is what stops a service launching a process anywhere on the
  // machine. Checked HERE against the roots this environment advertised, never trusted from the wire.
  const api = fakeApi({ launch: { ...LAUNCH, cwd: "C:/somewhere-else" } });
  const { result, processes } = await run({ api });
  assert.equal(result.outcome, "refused");
  assert.equal(processes.calls.starts.length, 0, "a process started outside the advertised roots");
  assert.match(api.reports[0].error, /outside this environment's advertised roots/);
});

test("a terminal with NO argv is refused rather than split from its command string", async () => {
  // An operator-supplied command has no structural form, and splitting a human's shell string is the
  // quoting bug this design avoids. Starting something invented from it would be worse than not.
  const api = fakeApi({ launch: { ...LAUNCH, argv: [] } });
  const { result, processes } = await run({ api });
  assert.equal(result.outcome, "refused");
  assert.equal(processes.calls.starts.length, 0);
  assert.match(result.detail, /no argv/);
});

test("input, resize and stop reach the host and are reported", async () => {
  const write = await run({ control: control({ action: "input", body: "hello" }) });
  assert.deepEqual(write.processes.calls.writes, [{ id: "term-1", data: "hello" }]);
  assert.equal(write.api.reports[0].terminalStatus, "attached");

  const resize = await run({ control: control({ action: "resize", cols: 120, rows: 40 }) });
  assert.deepEqual(resize.processes.calls.resizes, [{ id: "term-1", cols: 120, rows: 40 }]);

  const stop = await run({ control: control({ action: "stop" }) });
  assert.deepEqual(stop.processes.calls.stops, ["term-1"]);
  assert.equal(stop.api.reports[0].terminalStatus, "stopped");
});

test("an action this host does not implement is NAMED, not dropped", async () => {
  // A control the service is waiting on and never hears about is indistinguishable from a slow host.
  const { result, api } = await run({ control: control({ action: "teleport" }) });
  assert.equal(result.outcome, "failed");
  assert.match(api.reports[0].error, /unsupported terminal control action "teleport"/);
});

test("a start that THROWS is reported with the host's own reason", async () => {
  const { result, api } = await run({ processes: fakeProcesses({ startThrows: "spawn EACCES" }) });
  assert.equal(result.outcome, "failed");
  assert.match(api.reports[0].error, /EACCES/);
});

test("EVERY PATH THAT CLAIMS A CONTROL ALSO REPORTS IT", async () => {
  // The property, over all the outcomes at once rather than trusted per test above. A control the
  // service never hears about again is one it hands to nobody else.
  const cases = [
    { name: "started", over: {} },
    { name: "refused-roots", over: { api: fakeApi({ launch: { ...LAUNCH, cwd: "C:/elsewhere" } }) } },
    { name: "refused-launcher", over: { resolveCandidates: resolveTo() } },
    { name: "failed-start", over: { processes: fakeProcesses({ startThrows: "boom" }) } },
    { name: "unsupported", over: { control: control({ action: "nope" }) } },
  ];
  for (const c of cases) {
    const { api } = await run(c.over);
    assert.ok(api.reports.length > 0, `the ${c.name} path claimed a control and reported nothing`);
    assert.equal(api.reports[0].id, "ctl-1", `${c.name} reported against the wrong control`);
  }
});

test("a service that cannot be reached does not stop the next pass", async () => {
  // Reported, never thrown: a service being down is not something this host can act on, and an
  // exception here would take down the loop that starts every worker.
  const result = await runTerminalControlPass({
    api: fakeApi({ claimThrows: "connect ECONNREFUSED" }),
    processes: fakeProcesses(),
    environmentId: "e",
    withinRoots: workspaceWithinRoots,
    buildSpec,
    resolveCandidates: resolveTo("C:/bin/claude-aify"),
  });
  assert.equal(result.outcome, "unreachable");
  assert.match(result.detail, /ECONNREFUSED/);
});

test("ONE BAD CONTROL DOES NOT HIDE THE ONES BEHIND IT", async () => {
  // The bridge learned this in a different loop: a single broken item stopped the pass and every
  // item behind it went unprocessed with nothing saying so.
  const api = fakeApi({
    controls: [control({ id: "bad", action: "nope" }), control({ id: "good", action: "stop" })],
  });
  const processes = fakeProcesses();
  const result = await runTerminalControlPass({
    api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
  });
  assert.equal(result.handled, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(processes.calls.stops, ["term-1"], "the control behind the bad one never ran");
});

test("an empty queue is IDLE, which is the usual case and must be cheap", async () => {
  const result = await runTerminalControlPass({
    api: fakeApi({ controls: [] }), processes: fakeProcesses(), environmentId: "e",
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
  });
  assert.equal(result.outcome, "idle");
  assert.equal(result.handled, 0);
});
