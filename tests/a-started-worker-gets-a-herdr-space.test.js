// A worker started inside `herdr-aify env` gets a Herdr space, and one started anywhere else does not.
//
// THE DEFECT THIS EXISTS FOR, reported with the feature otherwise working: the operator started
// `comms-senior-dev` and `ef-manager` from the picker inside a dedicated instance. Both came up --
// "they started but i do not see new space in herdr. it should star one right ?" -- as ordinary
// children of a daemon that merely happened to live in a pane, which is indistinguishable from
// running outside Herdr. The spaces were the operator's entire reason for the mode: "lets that
// aify-env manage/spawn/kill other spaces".
//
// AND THE SECOND HALF, reported once the first worked: "it seems that killing just killed process in
// that space, but it did not kill the space where agent was running."
//
// AND WHAT REVIEW FOUND IN BOTH, 2026-09-13: the opener ran for ANY inherited Herdr socket, including
// the operator's own resident Herdr; it closed by WORKSPACE id, which would take any unrelated pane an
// operator had moved into that space with it; and a pane created before a later step failed, or for a
// worker whose stream was already released, was never closed at all.
//
// WHAT IS ASSERTED, and what deliberately is not. That a pane is opened for a terminal-backed worker
// this daemon started, only inside its own dedicated instance; that it ATTACHES rather than re-running
// the agent; that exactly the pane it created is closed when the worker goes, whatever went wrong on
// the way; and that no failure ever fails the start. Herdr's own drawing is Herdr's.

import test from "node:test";
import assert from "node:assert/strict";

import { paneOpenerFor } from "../lib/herdr-pane-opener.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";

const WINDOWS = process.platform === "win32";
const skip = WINDOWS ? false : "attachCommand builds a Windows PowerShell command";

//: A dedicated invocation's root, and the socket its Herdr serves inside it.
const ROOT = "C:/aify/herdr/invocations/5d8e2a3c-1f4b-4c6d-9e7f-0a1b2c3d4e5f";
const SOCKET = `${ROOT}/herdr-tui.sock`;
const CREATED = { result: { root_pane: { pane_id: "w2:p1", workspace_id: "w2" }, workspace: { workspace_id: "w2" } } };
const SHELL = { result: { process_info: { shell_pid: 4242 } } };

/** A Herdr that answers the way the real CLI does, and records what it was asked. */
function fakeHerdr({ onCall = null } = {}) {
  const calls = [];
  const call = (_bin, argv, opts) => {
    calls.push({ argv, socket: opts.socket });
    if (onCall) {
      const answer = onCall(argv);
      if (answer !== undefined) return answer;
    }
    return argv[1] === "process-info" ? SHELL : CREATED;
  };
  return { calls, call, closes: () => calls.filter(c => c.argv[1] === "close").map(c => c.argv) };
}

/** Timers that run only when told to, so "outside the exit notification" and "later" are observable. */
function manualTimers() {
  const queue = [];
  return {
    queue,
    defer: (fn, ms) => { queue.push({ fn, ms }); },
    flush: () => { while (queue.length) queue.shift().fn(); },
  };
}

function opener({ env = { HERDR_SOCKET_PATH: SOCKET }, dedicatedRoot = ROOT, herdr = fakeHerdr(), log = () => {}, watchExit = null, timers = manualTimers() } = {}) {
  return paneOpenerFor({
    env,
    dedicatedRoot,
    base: "http://127.0.0.1:65000",
    node: "C:/node/node.exe",
    script: "C:/aify-env/bin/aify-env.mjs",
    cwd: "C:/work",
    log,
    bin: "C:/herdr/herdr.exe",
    call: herdr.call,
    watchExit,
    defer: timers.defer,
  });
}

test("NO HERDR, NO OPENER: an ordinary daemon grows nothing", () => {
  assert.equal(opener({ env: {} }), null, "a daemon outside Herdr built a pane opener");
  assert.equal(paneOpenerFor({ env: { HERDR_SOCKET_PATH: "C:/s.sock" } }), null, "an opener with nothing to attach to");
});

test("A HERDR THAT IS NOT THIS INVOCATION'S IS NEVER DRIVEN", () => {
  // Found by review. An ordinary daemon started from a pane of the persistent `herdr-aify` -- which is
  // for residents, and must not grow managed agents' panes -- inherits that resident's socket, and
  // the opener was enabled by the socket alone.
  const resident = { HERDR_SOCKET_PATH: "C:/Users/op/.aify/herdr/resident/herdr-tui.sock" };
  assert.equal(opener({ env: resident, dedicatedRoot: null }), null, "an ordinary daemon drives the Herdr it was started in");
  assert.equal(opener({ env: resident }), null, "a dedicated daemon drives a Herdr outside its own invocation");
  // A sibling whose name merely starts with this root is still somebody else's.
  assert.equal(opener({ env: { HERDR_SOCKET_PATH: `${ROOT}-other/herdr-tui.sock` } }), null, "a lookalike root was accepted");
  // POSITIVE CONTROL: the invocation's own socket still gets an opener.
  assert.equal(typeof opener(), "function", "the dedicated instance lost its opener");
});

test("THE DEFECT: a started worker gets a space, attached to the worker that is already running", { skip }, async () => {
  const herdr = fakeHerdr();
  const openPane = opener({ herdr });
  const opened = await openPane({ id: "proc-1", label: "comms-senior-dev", terminal: true });
  assert.equal(opened.paneId, "w2:p1", "no space was opened for a started worker");
  const { calls } = herdr;
  assert.equal(calls.length, 3, "a space, the wait for its shell, and the command typed into it");
  assert.deepEqual(calls[1].argv.slice(0, 2), ["pane", "process-info"], "it typed without waiting for a shell");

  // THE SPACE, named for the agent an operator is looking for rather than an opaque process id.
  assert.deepEqual(calls[0].argv.slice(0, 3), ["workspace", "create", "--label"]);
  assert.equal(calls[0].argv[3], "aify-env comms-senior-dev");
  // ON THIS INSTANCE'S OWN HERDR. The wrong socket would drive the operator's ordinary Herdr.
  assert.equal(calls[0].socket, SOCKET, "the space was opened on the wrong Herdr");

  // THE ATTACH IS THE POINT. The worker keeps its PTY and its dashboard console; a pane that re-ran
  // the agent would take both, and a visible TUI in the web console is a standing requirement.
  assert.deepEqual(calls[2].argv.slice(0, 3), ["pane", "run", "w2:p1"]);
  assert.equal(calls[2].argv[3], "powershell.exe");
  const encoded = calls[2].argv[calls[2].argv.length - 1];
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /aify-env\.mjs' attach --id 'proc-1'/, "the pane does not attach to the running worker");
  assert.match(decoded, /AIFY_ENV_ENDPOINT='http:\/\/127\.0\.0\.1:65000'/, "the pane was pointed at no daemon");
});

test("a worker with no terminal gets no pane, because there is nothing to attach to", { skip }, async () => {
  const herdr = fakeHerdr();
  const openPane = opener({ herdr });
  assert.equal(await openPane({ id: "headless", terminal: false }), null);
  assert.equal(await openPane({ id: "headless" }), null);
  assert.equal(await openPane(null), null);
  assert.deepEqual(herdr.calls, [], "a pane was opened onto a worker with no PTY");
});

test("A PANE THAT WILL NOT OPEN NEVER FAILS THE START", { skip }, async () => {
  const logs = [];
  const herdr = fakeHerdr({ onCall: () => { throw new Error("Herdr said no"); } });
  const openPane = opener({ herdr, log: m => logs.push(m) });
  assert.equal(await openPane({ id: "x", terminal: true }), null, "a refused pane became a thrown start");
  assert.ok(logs.some(l => l.includes("no space for x")), "a missing pane was swallowed silently");
});

test("THE CALL SITE: PluginProcesses runs the opener after the start, and survives a throwing one", async () => {
  // The opener proven alone says nothing about whether a start ever calls it -- the defect shape this
  // project keeps meeting. Driven through the real PluginProcesses with a fake Runner.
  const seen = [];
  const runner = { start: async spec => ({ id: spec.id, terminal: true }) };

  const withOpener = new PluginProcesses(runner, { onStarted: record => { seen.push(record); } });
  assert.deepEqual(await withOpener.start({ id: "a" }), { id: "a", terminal: true });
  assert.deepEqual(seen.map(r => r.id), ["a"], "the start never reached the opener");

  // THE NAME AN OPERATOR IS LOOKING FOR. A started record carries the process id and not always the
  // agent's name, and a space called `aify-env 68583473-ccaa-...-p1` helps nobody find `sc-tester`.
  const named = new PluginProcesses(runner, { onStarted: record => { seen.push(record); } });
  await named.start({ id: "d", label: "sc-tester" });
  assert.equal(seen.at(-1).label, "sc-tester", "the agent's name never reached the space");

  // A THROWING OPENER MUST NOT BREAK A RUNNING AGENT. The worker is already up by this point.
  const hostile = new PluginProcesses(runner, { onStarted: () => { throw new Error("no herdr"); } });
  assert.deepEqual(await hostile.start({ id: "b" }), { id: "b", terminal: true });

  // NEGATIVE CONTROL: with no opener the start is exactly what it always was.
  const plain = new PluginProcesses(runner);
  assert.deepEqual(await plain.start({ id: "c" }), { id: "c", terminal: true });
});

test("THE SECOND DEFECT: the worker's PANE closes when the worker goes, and nothing else does", { skip }, async () => {
  // TAKEN FROM THE RUNNER, not from the stop call: a worker killed from outside, or one that simply
  // dies, must take its pane with it too.
  //
  // THE PANE, NOT THE WORKSPACE. Measured against Herdr 0.9.0 on a private server: closing a space's
  // last pane removes the space, and closing ours while an unrelated pane shares the space leaves that
  // pane alone. `workspace close` would have destroyed it.
  const herdr = fakeHerdr();
  const logs = [];
  const watched = new Map();
  const timers = manualTimers();
  const openPane = opener({ herdr, timers, log: m => logs.push(m), watchExit: (id, onExit) => watched.set(id, onExit) });

  const opened = await openPane({ id: "proc-1", label: "sc-tester", terminal: true });
  assert.equal(opened.paneId, "w2:p1");
  assert.deepEqual([...watched.keys()], ["proc-1"], "nothing is watching the worker, so its pane outlives it");
  assert.deepEqual(herdr.closes(), [], "the pane was closed while the worker ran");

  watched.get("proc-1")(0, null);
  // OUTSIDE THE EXIT NOTIFICATION. The close is a blocking CLI call; the notification that asks for it
  // carries other workers' business.
  assert.deepEqual(herdr.closes(), [], "the close ran inside the Runner's exit notification");
  timers.flush();
  assert.deepEqual(herdr.closes(), [["pane", "close", "w2:p1"]], "the worker exited and its pane stayed open");
  assert.equal(herdr.calls.some(c => c.argv[0] === "workspace" && c.argv[1] === "close"), false, "a whole workspace was closed");
  assert.ok(logs.some(l => l.includes("closed w2:p1")), "a closed pane said nothing");
});

test("A PANE THAT WILL NOT CLOSE IS TRIED ONCE MORE, then reported -- never thrown", { skip }, async () => {
  const logs = [];
  const watched = new Map();
  const timers = manualTimers();
  let refusals = 1;
  const herdr = fakeHerdr({ onCall: argv => {
    if (argv[0] === "pane" && argv[1] === "close" && refusals-- > 0) throw new Error("herdr is busy");
    return undefined;
  } });
  const openPane = opener({ herdr, timers, log: m => logs.push(m), watchExit: (id, onExit) => watched.set(id, onExit) });
  await openPane({ id: "proc-2", terminal: true });
  watched.get("proc-2")(null, "SIGKILL");
  timers.flush();
  assert.equal(herdr.closes().length, 2, "a close that failed once was never retried");
  assert.ok(logs.some(l => l.includes("w2:p1 outlived proc-2")), "the failed first attempt said nothing");
  assert.ok(logs.some(l => l.includes("closed w2:p1")), "the retry did not close it");

  // AND THE RETRY IS BOUNDED: a close that always fails stops after its second try.
  const stubborn = fakeHerdr({ onCall: argv => { if (argv[1] === "close") throw new Error("still busy"); return undefined; } });
  const again = new Map();
  const later = manualTimers();
  await opener({ herdr: stubborn, timers: later, watchExit: (id, on) => again.set(id, on) })({ id: "p3", terminal: true });
  again.get("p3")(1, null);
  later.flush();
  assert.equal(stubborn.closes().length, 2, "a close that never succeeds was retried without end");
});

test("A PANE THAT IS ALREADY GONE IS NOT A FAILURE", { skip }, async () => {
  // Herdr answers `pane_not_found` for a pane somebody else closed. That is the outcome the close
  // wanted, so it is neither retried nor reported as a leftover.
  const logs = [];
  const watched = new Map();
  const timers = manualTimers();
  const herdr = fakeHerdr({ onCall: argv => {
    if (argv[1] === "close") throw Object.assign(new Error("pane w2:p1 not found"), { code: "pane_not_found" });
    return undefined;
  } });
  await opener({ herdr, timers, log: m => logs.push(m), watchExit: (id, on) => watched.set(id, on) })({ id: "p4", terminal: true });
  watched.get("p4")(0, null);
  timers.flush();
  assert.equal(herdr.closes().length, 1, "a pane already gone was tried again");
  assert.equal(logs.some(l => l.includes("outlived")), false, "a pane already gone was reported as left behind");
});

test("A PANE MADE BEFORE A LATER STEP FAILED IS CLOSED, not left empty", { skip }, async () => {
  // Found by review: the space was created, then the shell poll or the typed command failed, and the
  // catch logged it and walked away -- an empty space with the agent's name on it, for ever.
  for (const failing of ["process-info", "run"]) {
    const timers = manualTimers();
    const herdr = fakeHerdr({ onCall: argv => { if (argv[1] === failing) throw new Error(`${failing} failed`); return undefined; } });
    assert.equal(await opener({ herdr, timers })({ id: "p5", terminal: true }), null);
    timers.flush();
    assert.deepEqual(herdr.closes(), [["pane", "close", "w2:p1"]], `a pane created before "${failing}" failed was left behind`);
  }
  // CONTROL: when nothing was created, nothing is closed.
  const timers = manualTimers();
  const never = fakeHerdr({ onCall: argv => { if (argv[0] === "workspace") throw new Error("no space"); return undefined; } });
  await opener({ herdr: never, timers })({ id: "p6", terminal: true });
  timers.flush();
  assert.deepEqual(never.closes(), [], "a close was sent for a pane that never existed");
});

test("A WORKER ALREADY RELEASED BY THE TIME IT IS WATCHED STILL LOSES ITS PANE", { skip }, async () => {
  // Found by review. The Runner answers null for a stream it has already released, and the opener
  // ignored that answer -- so there was no exit left to hear, and the pane stayed.
  const timers = manualTimers();
  const herdr = fakeHerdr();
  await opener({ herdr, timers, watchExit: () => null })({ id: "p7", terminal: true });
  timers.flush();
  assert.deepEqual(herdr.closes(), [["pane", "close", "w2:p1"]], "a worker gone before it could be watched kept its pane");
});

test("NOTHING IS WATCHED WHEN NO SPACE WAS OPENED", { skip }, async () => {
  // NEGATIVE CONTROL, driven by removing the thing under test. A watch registered for a worker with
  // no pane would close whatever id happened to be held, and would leak on every headless worker.
  const watched = [];
  const watchExit = (id) => { watched.push(id); return () => {}; };
  const refused = opener({ herdr: fakeHerdr({ onCall: () => { throw new Error("Herdr said no"); } }), watchExit });
  assert.equal(await refused({ id: "x", terminal: true }), null);
  const headless = opener({ watchExit });
  assert.equal(await headless({ id: "no-pty", terminal: false }), null);
  assert.deepEqual(watched, [], "an exit watch was registered for a worker that got no pane");
});

test("THE DAEMON BUILDS ONE, read rather than run, because importing it STARTS a daemon", async () => {
  // A source assertion, used for the one reason that justifies it: importing `bin/aify-env.mjs` runs
  // the daemon, which supersedes whatever serves this host and reaps its managed workers. The gate
  // it defends is real -- an opener nothing constructs is an opener that never opens anything.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs"), "utf8");
  assert.match(source, /paneOpenerFor\(\{/, "the daemon never builds a pane opener");
  assert.match(source, /new PluginProcesses\(runner, \{ onStarted: paneOpener \}\)/, "the opener reaches no start");
  // AND THE EXIT IT CLOSES ON COMES FROM THE RUNNER. An opener built without `watchExit` opens every
  // pane and closes none, which is invisible to every test above -- they inject their own.
  assert.match(source, /watchExit: \(id, on\) => runner\.subscribe\(id, \(\) => \{\}, on\)/, "the opener learns no exit");
  // AND ITS AUTHORITY IS THIS DAEMON'S OWN INVOCATION. Without it every opener is refused, and a
  // dedicated instance silently stops opening spaces -- the very first defect, back again.
  assert.match(source, /dedicatedRoot: instanceContext\?\.root/, "the opener is not bound to this invocation");
});
