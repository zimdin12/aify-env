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

import {
  TERMINAL_ENDED,
  createHandleBook,
  runOneControl,
  runTerminalControlPass,
} from "../lib/plugins/aify-comms/terminal-controls.mjs";
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
    outputs: [],
    async terminalOutput(terminalId, body) { this.outputs.push({ terminalId, ...body }); },
  };
}

function fakeProcesses({ startThrows = null } = {}) {
  const calls = { starts: [], writes: [], resizes: [], stops: [], subscribed: [] };
  return {
    calls,
    async start(spec) {
      calls.starts.push(spec);
      if (startThrows) throw new Error(startThrows);
      return { id: "proc-1", pid: 4242 };
    },
    subscribe(id, onOutput, onExit) {
      calls.subscribed.push(id);
      // THE REAL RUNNER KEYS ITS STREAMS BY ITS OWN PROCESS ID and answers `null` for anything else
      // — SILENTLY. This fake accepted any id, so it agreed with a call that found no stream, and a
      // healthy worker's console stayed empty in production while this test passed. A fake that is
      // more permissive than the thing it stands for is a test that cannot fail.
      if (id !== "proc-1") return null;
      // Handed back so a test can drive the process's own output and exit, which is the only way to
      // prove this host CARRIES them rather than merely registering interest.
      calls.emit = onOutput;
      calls.exit = onExit;
      return () => {};
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
  const handles = over.handles || createHandleBook();
  return runOneControl({
    handles,
    control: over.control || control(),
    api,
    processes,
    cwdRoots: ROOTS,
    windows: true,
    withinRoots: workspaceWithinRoots,
    buildSpec: over.buildSpec || buildSpec,
    resolveCandidates: over.resolveCandidates || resolveTo("C:/bin/claude-aify"),
    baseEnv: over.baseEnv || { PATH: "C:/bin", AIFY_AGENT_ROLE: "coder" },
  }).then((result) => ({ result, api, processes, handles }));
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
  // ADDRESSED BY THE RUNNER'S HANDLE, which the service carries on the control because this host
  // reported it at start. The runner does not answer to a terminal id, so a write sent that way
  // reaches nothing and reports success — the same silence as the subscription above.
  const book = createHandleBook();
  await run({ handles: book });  // start it first, so this host knows what to address
  const write = await run({ handles: book, control: control({ action: "input", body: "hello" }) });
  assert.deepEqual(write.processes.calls.writes, [{ id: "proc-1", data: "hello" }]);
  assert.equal(write.api.reports[0].terminalStatus, "attached");

  const resize = await run({ handles: book, control: control({ action: "resize", cols: 120, rows: 40 }) });
  assert.deepEqual(resize.processes.calls.resizes, [{ id: "proc-1", cols: 120, rows: 40 }]);

  const stop = await run({ handles: book, control: control({ action: "stop" }) });
  assert.deepEqual(stop.processes.calls.stops, ["proc-1"]);
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
    handles: createHandleBook(),
  });
  assert.equal(result.outcome, "unreachable");
  assert.match(result.detail, /ECONNREFUSED/);
});

test("ONE BAD CONTROL DOES NOT HIDE THE ONES BEHIND IT", async () => {
  // The bridge learned this in a different loop: a single broken item stopped the pass and every
  // item behind it went unprocessed with nothing saying so.
  const api = fakeApi({
    // The second is a START, which stands alone. A `stop` would now be refused for a terminal this
    // host never started -- correct, and it would prove the wrong thing here.
    controls: [control({ id: "bad", action: "nope" }), control({ id: "good", action: "start" })],
  });
  const processes = fakeProcesses();
  const result = await runTerminalControlPass({
    api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: createHandleBook(),
  });
  assert.equal(result.handled, 2);
  assert.equal(result.failed, 1);
  assert.equal(processes.calls.starts.length, 1, "the control behind the bad one never ran");
});

test("an empty queue is IDLE, which is the usual case and must be cheap", async () => {
  const result = await runTerminalControlPass({
    api: fakeApi({ controls: [] }), processes: fakeProcesses(), environmentId: "e",
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: createHandleBook(),
  });
  assert.equal(result.outcome, "idle");
  assert.equal(result.handled, 0);
});

// ── the output stream, and the duplicate fleet it prevents ──────────────────────────────────────
//
// MEASURED 2026-09-03. Fourteen workers ran perfectly on this host and the service received not one
// byte from any of them, so its reconciler correctly called each terminal a dead ghost, marked it
// stopped, and issued a NEW start control — which this host obeyed, starting a second process
// beside the first. Two `sc-lead`s, two `sc-coder`s. The agent ids were unique throughout; what
// duplicated was the PROCESS, because starting one and then saying nothing about it is
// indistinguishable from never starting it.

test("a started terminal is subscribed BY THE RUNNER'S OWN ID, not the terminal id", async () => {
  // THE DEFECT, measured 2026-09-03 on a live worker. The runner keys its streams by the id IT
  // returns from `start` (`<instance>-p1`); the terminal id is the service's name for the same
  // thing and the runner has never heard of it. Subscribing with it found no stream and `subscribe`
  // answered `null` silently, so a perfectly healthy worker produced 1,630 bytes of output that
  // nothing carried, and the operator watched an empty console in the dashboard.
  const { result, processes } = await run();
  assert.equal(result.outcome, "started");
  assert.deepEqual(processes.calls.subscribed, ["proc-1"],
    "subscribed by the wrong key, so nothing carries this process's output");
});

test("A SUBSCRIPTION THAT ATTACHED TO NOTHING FAILS THE CONTROL", async () => {
  // Taking `null` as success is how the empty console shipped: the control reported `attached`, the
  // service believed it, and no byte ever arrived — then the reconciler concluded the terminal was
  // dead and asked for another worker. Reported now, rather than inferred three minutes later.
  const processes = fakeProcesses();
  processes.subscribe = (id) => { processes.calls.subscribed.push(id); return null; };
  const { result, api } = await run({ processes });
  assert.equal(result.outcome, "failed");
  assert.match(api.reports[0].error, /could not subscribe to its output/);
});

test("output is CARRIED to the service, not merely listened for", async () => {
  const { api, processes } = await run();
  processes.calls.emit("hello from the worker");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.outputs.map((o) => o.output), ["hello from the worker"]);
  assert.equal(api.outputs[0].terminalId, "term-1");
  assert.equal(api.outputs[0].status, "attached");
});

test("THE EXIT IS REPORTED, with its code and signal kept apart", async () => {
  // An exit code alone cannot tell a crash from a kill on Windows, where an externally terminated
  // process and a program returning 1 are the same number.
  const { api, processes } = await run();
  processes.calls.exit(0, null);
  await new Promise((resolve) => setImmediate(resolve));
  const exit = api.outputs.at(-1);
  assert.equal(exit.status, "stopped");
  assert.equal(exit.exitCode, 0, "0 is a CLEAN exit and the most common value — truthiness drops it");
  assert.equal("exitSignal" in exit, false, "an absent field means nobody said, never zero");
});

test("a SIGNALLED exit keeps its signal and reports no code", async () => {
  const { api, processes } = await run();
  processes.calls.exit(null, "SIGKILL");
  await new Promise((resolve) => setImmediate(resolve));
  const exit = api.outputs.at(-1);
  assert.equal(exit.exitSignal, "SIGKILL");
  assert.equal("exitCode" in exit, false, '"killed by SIGKILL" and "exited 0" are different answers');
});

test("a failed OUTPUT post does not stop the next chunk", async () => {
  // It is a listener, not a request: there is nobody above it to hand an error to, and one dropped
  // POST must not silence a worker for the rest of its life.
  const logs = [];
  const api = fakeApi();
  api.terminalOutput = async () => { throw new Error("service down"); };
  const processes = fakeProcesses();
  await runOneControl({
    control: control(), api, processes, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: createHandleBook(), baseEnv: {}, log: (m) => logs.push(String(m)),
  });
  processes.calls.emit("first");
  processes.calls.emit("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((l) => /output not delivered/.test(l)), "a dropped chunk must be said, not swallowed");
});

test("the subscription happens BEFORE the control is reported complete", async () => {
  // Otherwise there is a window where the service believes a terminal is attached and nothing is
  // carrying its output — which is the reconcile-as-dead race in miniature.
  const order = [];
  const api = fakeApi();
  const realReport = api.reportControl.bind(api);
  api.reportControl = async (id, patch) => { order.push("report"); return realReport(id, patch); };
  const processes = fakeProcesses();
  const realSubscribe = processes.subscribe.bind(processes);
  processes.subscribe = (...args) => { order.push("subscribe"); return realSubscribe(...args); };
  await runOneControl({
    control: control(), api, processes, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: createHandleBook(), baseEnv: {},
  });
  assert.deepEqual(order, ["subscribe", "report"]);
});

// ── the handle book: two tiers naming one thing ─────────────────────────────────────────────────
//
// The service addresses a terminal by ITS id; the runner answers only to the id it returned from
// `start`. Only this host knows both, because it is the one that started the process. Getting that
// wrong is not loud: `subscribe` answers `null` for an id it does not know, and a healthy worker's
// console stayed empty in the dashboard while every status read fine.

test("a control for a terminal this host never started is REFUSED with that reason", async () => {
  // Not "no such process", which is what the runner would say and would send a reader looking for a
  // dead worker. This host simply never started it — another environment did, or this daemon has
  // restarted since — and those are different problems with different remedies.
  const { result, api } = await run({ control: control({ action: "stop" }) });
  assert.equal(result.outcome, "failed");
  assert.match(api.reports[0].error, /no process for terminal "term-1"/);
  assert.match(api.reports[0].error, /started elsewhere, or this daemon has restarted since/);
});

test("STOPPING FORGETS THE TERMINAL, so a stale handle cannot be reused", async () => {
  // Runner ids are unique per instance and recycled per process. Keeping a stopped terminal's handle
  // would let a later control address whatever now holds that id — the cross-kill this project has
  // already paid for once, on a recycled pid.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  assert.equal(book.handleFor("term-1"), "proc-1");
  await run({ handles: book, processes, control: control({ action: "stop" }) });
  assert.equal(book.handleFor("term-1"), "", "a stopped terminal must leave no handle behind");
});

test("the book answers EMPTY for an unknown terminal, never the terminal id", async () => {
  // The fallback looks harmless and is not: the runner would refuse an id it has never seen, and the
  // action would be reported failed for the wrong reason.
  const book = createHandleBook();
  assert.equal(book.handleFor("term-unknown"), "");
  book.remember("term-1", "proc-9");
  assert.equal(book.handleFor("term-1"), "proc-9");
  book.remember("term-2", "");
  assert.equal(book.handleFor("term-2"), "", "a blank handle is not worth remembering");
});

// ── quiet is not dead ───────────────────────────────────────────────────────────────────────────
//
// MEASURED 2026-09-03. A worker started, its console attached, it carried the first-run prompt to
// the dashboard — and then went quiet, because it was WAITING at that prompt. Ninety seconds later
// the service's reconciler declared the terminal a dead ghost, and `comms_console_input` refused to
// send the Enter that would have freed it, because the terminal was "not live". The process was
// alive the whole time.
//
// The reconciler was not wrong. It reaps only when ALL of its signals are absent — no claimer
// sidecar, no wrapper child, no output in 90 seconds — and for a worker parked at its first prompt
// all three are absent. Nothing had told it the process was there, and this host is the only thing
// that knows.

test("EVERY PASS REPORTS THE TERMINALS THIS HOST IS RUNNING", async () => {
  const book = createHandleBook();
  const api = fakeApi({ controls: [] });
  await run({ handles: book });                 // start one, so the host holds it
  api.outputs.length = 0;

  await runTerminalControlPass({
    api, processes: fakeProcesses(), environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: book,
  });
  assert.deepEqual(api.outputs.map((o) => o.terminalId), ["term-1"],
    "a quiet worker is reaped in 90s unless this host says it is alive");
});

test("the liveness frame is EMPTY and carries NO status", async () => {
  // Empty because a non-empty chunk appends a console event and feeds the screen — a heartbeat must
  // not write into the operator's console. No status, because sending one would let this frame
  // REOPEN a terminal an operator or a reconciler had deliberately closed.
  const book = createHandleBook();
  const api = fakeApi({ controls: [] });
  await run({ handles: book });
  api.outputs.length = 0;

  await runTerminalControlPass({
    api, processes: fakeProcesses(), environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: book,
  });
  assert.equal(api.outputs[0].output, "");
  assert.equal("status" in api.outputs[0], false, "a liveness frame must not transition status");
});

test("AN EXITED TERMINAL IS NOT REPORTED ALIVE", async () => {
  // The failure that would be worse than the one being fixed: a host insisting a dead worker lives
  // keeps a ghost console open for ever, and nothing else in the system can contradict it.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.exit(0, null);                // the worker ends
  await new Promise((resolve) => setImmediate(resolve));

  const api = fakeApi({ controls: [] });
  await runTerminalControlPass({
    api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: book,
  });
  assert.deepEqual(api.outputs, [], "a terminal that exited was still reported as running");
});

test("a failed liveness report does not stop the pass", async () => {
  // It would trade a reaped console for a host that stops running anything at all.
  const book = createHandleBook();
  await run({ handles: book });
  const logs = [];
  const api = fakeApi({ controls: [] });
  api.terminalOutput = async () => { throw new Error("service down"); };
  const result = await runTerminalControlPass({
    api, processes: fakeProcesses(), environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles: book, log: (m) => logs.push(String(m)),
  });
  assert.equal(result.outcome, "idle");
  assert.ok(logs.some((l) => /could not report terminal .* alive/.test(l)));
});

// ── one agent, one worker ───────────────────────────────────────────────────────────────────────
//
// MEASURED TWICE on 2026-09-03: two `sc-lead`s, two `sc-coder`s, and the operator asked where the
// uniqueness check was. There wasn't one. The service asked for the second and was RIGHT to — it
// believed the first was dead, and replacing a dead worker is what it should do. What was missing is
// that this host already held a live process for that agent and started another anyway.
//
// Two claude instances in one working directory is also its own failure, independent of the count.

test("A SECOND WORKER IS REFUSED — THE LIVE SESSION WINS", async () => {
  // THE REGRESSION THIS REVERSES, measured on the operator's fleet 2026-09-03. The first version
  // REPLACED, and it destroyed four working sessions in ten minutes, including a lead mid-design-
  // note. A message arrives for a lane whose claude is idle at its own prompt, the service concludes
  // there is no worker and asks for a new terminal, this host stopped the RUNNING one to honour it,
  // and the replacement parked on a first-run dialog. The lane's context was gone.
  //
  // Before the rule existed both ran, which was bad. With it, the working one died, which is worse.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;
  processes.calls.starts.length = 0;

  const api = fakeApi({ launch: { ...LAUNCH, terminalId: "term-2" } });
  const second = await runOneControl({
    control: control({ id: "ctl-2", terminalId: "term-2" }),
    api, processes, handles: book, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    baseEnv: {},
  });

  assert.equal(second.outcome, "refused");
  assert.deepEqual(processes.calls.stops, [], "IT KILLED THE LIVE SESSION -- the regression is back");
  assert.deepEqual(processes.calls.starts, [], "and it must not start a second one either");
  assert.equal(book.handleFor("term-1"), "proc-1", "the live worker must still be held");
});

test("the refusal NAMES the live terminal, so the caller can act on it", async () => {
  // A refusal the service cannot act on is a stall. Naming the terminal and the process is what lets
  // it stop the old one explicitly and ask again -- which is the supported way to replace a worker.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  const api = fakeApi({ launch: { ...LAUNCH, terminalId: "term-2" } });
  await runOneControl({
    control: control({ id: "ctl-2", terminalId: "term-2" }),
    api, processes, handles: book, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    baseEnv: {},
  });
  assert.match(api.reports[0].error, /already running a worker for "sc-lead" on terminal term-1/);
  assert.match(api.reports[0].error, /Stop it explicitly and ask again/);
});

test("A RESTART STILL WORKS: stop first, then start", async () => {
  // The case refusing must not block. A real restart stops the worker -- explicitly, or by the
  // process exiting -- and either way this host has forgotten the terminal before the start arrives.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  await run({ handles: book, processes, control: control({ action: "stop" }) });
  processes.calls.starts.length = 0;

  const api = fakeApi({ launch: { ...LAUNCH, terminalId: "term-2" } });
  const restarted = await runOneControl({
    control: control({ id: "ctl-2", terminalId: "term-2" }),
    api, processes, handles: book, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    baseEnv: {},
  });
  assert.equal(restarted.outcome, "started", "a legitimate restart was blocked");
});

test("a worker that EXITED does not block its own replacement", async () => {
  // The other route to a restart, and the common one: the process ends by itself.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.exit(0, null);
  await new Promise((resolve) => setImmediate(resolve));

  const api = fakeApi({ launch: { ...LAUNCH, terminalId: "term-2" } });
  const after = await runOneControl({
    control: control({ id: "ctl-2", terminalId: "term-2" }),
    api, processes, handles: book, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    baseEnv: {},
  });
  assert.equal(after.outcome, "started");
});

test("a DIFFERENT agent's worker is never refused or touched", async () => {
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;

  const api = fakeApi({ launch: { ...LAUNCH, terminalId: "term-2", agentId: "sc-coder" } });
  const other = await runOneControl({
    control: control({ id: "ctl-2", terminalId: "term-2" }),
    api, processes, handles: book, cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    baseEnv: {},
  });
  assert.equal(other.outcome, "started");
  assert.deepEqual(processes.calls.stops, [], "another agent's worker was stopped");
});

test("the same terminal restarting is NOT treated as a duplicate of itself", async () => {
  // The control carries the same terminal id when a terminal is simply re-started, and stopping
  // "the other worker for this agent" must not mean stopping the one being replaced in place.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;
  await run({ handles: book, processes });                       // same terminal id, same agent
  assert.deepEqual(processes.calls.stops, []);
});

// ── a worker must not outlive the work it was given ─────────────────────────────────────────────
//
// MEASURED 2026-09-03. `comms_remove_agent` does the right thing: it issues a stop control for the
// agent's terminals BEFORE tombstoning. But deleting the agent cascades agents -> sessions ->
// terminals -> terminal_controls, so the control is deleted milliseconds later, long before any host
// polling for work could claim it. It only ever worked because the bridge was in-process and won
// that race. A live worker was left running that nothing could address, because its agent id no
// longer existed — exactly the `managed-orphans` class the doctor exists to report.
//
// STATE, NOT AN EVENT. This repo's own rule: cleanup that must hold on ALL paths keys on the state,
// because an event can be lost — and this one is deleted by design. "I am holding a process for a
// terminal the service does not have" covers every route to it: remove, cascade, a database restored
// from backup, an operator deleting a row by hand.

/** An api whose liveness report answers 404 — the service no longer knows this terminal. */
function apiWithMissingTerminal() {
  const api = fakeApi({ controls: [] });
  api.terminalOutput = async () => {
    const error = new Error("PATCH /terminals/term-1 -> 404");
    error.status = 404;
    throw error;
  };
  return api;
}

async function passWith(api, { handles, processes, log = () => {} }) {
  return runTerminalControlPass({
    api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true,
    withinRoots: workspaceWithinRoots, buildSpec, resolveCandidates: resolveTo("C:/bin/claude-aify"),
    handles, log,
  });
}

test("A TERMINAL THE SERVICE NO LONGER HAS GETS ITS WORKER STOPPED", async () => {
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;

  await passWith(apiWithMissingTerminal(), { handles: book, processes });
  assert.deepEqual(processes.calls.stops, ["proc-1"],
    "a worker nothing can address any more was left running");
  assert.equal(book.handleFor("term-1"), "", "and it must be forgotten, or it is reported alive for ever");
});

test("it says WHY it stopped one, because an unexplained kill is worse than a leak", async () => {
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  const logs = [];
  await passWith(apiWithMissingTerminal(), { handles: book, processes, log: (m) => logs.push(String(m)) });
  assert.ok(logs.some((l) => /the service no longer has that terminal/.test(l)));
});

// ── the row is THERE and the service says the terminal is over ──────────────────────────────────
//
// THE HALF THE 404 RULE COULD NOT SEE, measured on the operator's host 2026-09-03. A worker had
// been running for two hours against `term_1788414394995_c339d2b4`, which the service listed as
// `stopped` with `process_id` 250952 -- and 250952 was alive. Hundreds of liveness passes walked
// straight past it, because the row EXISTS: the touch answers 200, not 404, so the rule below fired
// never. `aify-comms doctor` had been reporting the process as unaccounted the whole time.
//
// Every route to that state leaves the same orphan: `comms_remove_agent` stopping the terminal
// before the cascade, a reconciler declaring the console dead, an operator stopping it from the
// dashboard. Nothing will hand it work, address it with a control, or report it to anybody.
//
// THE SERVICE'S JUDGEMENT, ASKED -- never inferred from quiet. Quiet is what a worker between turns
// looks like, and killing on quiet destroyed four working sessions earlier the same night.

/** An api whose liveness report answers 200 with a terminal in `status`. */
function apiReporting(status) {
  const api = fakeApi({ controls: [] });
  api.terminalOutput = async (terminalId, body) => {
    api.outputs.push({ terminalId, ...body });
    return { ok: true, terminal: { id: terminalId, status } };
  };
  return api;
}

test("A TERMINAL THE SERVICE REPORTS STOPPED GETS ITS WORKER STOPPED", async () => {
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;

  await passWith(apiReporting("stopped"), { handles: book, processes });
  assert.deepEqual(processes.calls.stops, ["proc-1"],
    "a worker for a terminal the service considers over was left running");
  assert.equal(book.handleFor("term-1"), "", "and it must be forgotten, or it is retried for ever");
});

test("every END status the service uses is acted on, not just the one that was measured", async () => {
  for (const status of TERMINAL_ENDED) {
    const book = createHandleBook();
    const processes = fakeProcesses();
    await run({ handles: book, processes });
    processes.calls.stops.length = 0;

    await passWith(apiReporting(status), { handles: book, processes });
    assert.deepEqual(processes.calls.stops, ["proc-1"], `a terminal reported ${status} kept its worker`);
  }
});

test("A LIVE STATUS IS LEFT ALONE — this is the direction that kills working sessions", async () => {
  // The catastrophic mistake, and it has already been made once tonight in a different form. A
  // running terminal reports `attached`, `running` or `starting`; none of them is an end, and a
  // host that stopped on anything but an explicit end would reap the fleet it is hosting.
  for (const status of ["attached", "running", "starting", "active", "recovering", ""]) {
    const book = createHandleBook();
    const processes = fakeProcesses();
    await run({ handles: book, processes });
    processes.calls.stops.length = 0;

    await passWith(apiReporting(status), { handles: book, processes });
    assert.deepEqual(processes.calls.stops, [], `a live worker was reaped on status ${status || "(none)"}`);
    assert.equal(book.handleFor("term-1"), "proc-1", `and it must still be held on ${status || "(none)"}`);
  }
});

test("an answer with NO terminal at all changes nothing", async () => {
  // A service that stops returning the row, an older build, a proxy that strips the body: absence
  // of a status is not a report of death. Without this the rule would reap on every deployment that
  // changed the response shape.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;

  const api = fakeApi({ controls: [] });
  api.terminalOutput = async () => ({ ok: true });
  await passWith(api, { handles: book, processes });
  assert.deepEqual(processes.calls.stops, []);
  assert.equal(book.handleFor("term-1"), "proc-1");
});

test("it says WHY it stopped one on an end status too", async () => {
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  const logs = [];
  await passWith(apiReporting("failed"), { handles: book, processes, log: (m) => logs.push(String(m)) });
  assert.ok(logs.some((l) => /the service reports it failed/.test(l)),
    `an unexplained kill is worse than a leak; logs were ${JSON.stringify(logs)}`);
});

test("AN OUTAGE IS NOT A 404 — a worker survives the service being down", async () => {
  // The direction that would be catastrophic to get wrong: a service restart, a network blip or a
  // 500 must never reap a live fleet. Only an answer of "not found" counts, and only from the
  // service itself.
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.calls.stops.length = 0;

  for (const status of [0, 500, 502, 401, undefined]) {
    const api = fakeApi({ controls: [] });
    api.terminalOutput = async () => {
      const error = new Error(`failed with ${status}`);
      if (status !== undefined) error.status = status;
      throw error;
    };
    await passWith(api, { handles: book, processes });
  }
  assert.deepEqual(processes.calls.stops, [], "a transient failure reaped a live worker");
  assert.equal(book.handleFor("term-1"), "proc-1", "and the terminal must still be held");
});

test("a failure to stop the orphan still forgets it, so the pass cannot loop on it", async () => {
  const book = createHandleBook();
  const processes = fakeProcesses();
  await run({ handles: book, processes });
  processes.stop = async () => { throw new Error("already gone"); };
  const logs = [];
  await passWith(apiWithMissingTerminal(), { handles: book, processes, log: (m) => logs.push(String(m)) });
  assert.equal(book.handleFor("term-1"), "");
  assert.ok(logs.some((l) => /could not stop the orphaned worker/.test(l)));
});
