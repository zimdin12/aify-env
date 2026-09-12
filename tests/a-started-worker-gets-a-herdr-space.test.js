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
// that space, but it did not kill the space where agent was running." A space that outlives its
// worker is an empty window still labelled with an agent's name, so after a few kills the screen
// describes a fleet that is not running.
//
// WHAT IS ASSERTED, and what deliberately is not. That a pane is opened for a terminal-backed worker
// this daemon started, that it ATTACHES rather than re-running the agent, that the space CLOSES when
// the worker goes, that neither failure ever fails the start, and that an ordinary daemon opens
// nothing. Herdr's own drawing is Herdr's.

import test from "node:test";
import assert from "node:assert/strict";

import { paneOpenerFor } from "../lib/herdr-pane-opener.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";

const WINDOWS = process.platform === "win32";
const skip = WINDOWS ? false : "attachCommand builds a Windows PowerShell command";

function opener({ env = { HERDR_SOCKET_PATH: "C:/inv/herdr-tui.sock" }, call, log = () => {} } = {}) {
  return paneOpenerFor({
    env,
    base: "http://127.0.0.1:65000",
    node: "C:/node/node.exe",
    script: "C:/aify-env/bin/aify-env.mjs",
    cwd: "C:/work",
    log,
    bin: "C:/herdr/herdr.exe",
    call: call || ((_bin, argv) => (argv[0] === "pane" && argv[1] === "process-info"
      ? { result: { process_info: { shell_pid: 4242 } } }
      : { result: { root_pane: { pane_id: "w2:p1", workspace_id: "w2" }, workspace: { workspace_id: "w2" } } })),
  });
}

test("NO HERDR, NO OPENER: an ordinary daemon grows nothing", () => {
  assert.equal(opener({ env: {} }), null, "a daemon outside Herdr built a pane opener");
  assert.equal(paneOpenerFor({ env: { HERDR_SOCKET_PATH: "C:/s.sock" } }), null, "an opener with nothing to attach to");
});

test("THE DEFECT: a started worker gets a space, attached to the worker that is already running", { skip }, async () => {
  const calls = [];
  const openPane = opener({ call: (bin, argv, opts) => {
    calls.push({ bin, argv, socket: opts.socket });
    // THE PANE HAS A SHELL, which is what the opener must wait for before typing: a pane exists
    // before anything is listening in it, and text sent into that window is lost while the CLI
    // still reports success. A double that answered immediately would hide that wait.
    return argv[1] === "process-info"
      ? { result: { process_info: { shell_pid: 4242 } } }
      : { result: { root_pane: { pane_id: "w2:p1", workspace_id: "w2" }, workspace: { workspace_id: "w2" } } };
  } });
  assert.ok(openPane, "no opener was built inside a Herdr");

  const opened = await openPane({ id: "proc-1", label: "comms-senior-dev", terminal: true });
  assert.equal(opened.paneId, "w2:p1", "no space was opened for a started worker");
  assert.equal(calls.length, 3, "a space, the wait for its shell, and the command typed into it");
  assert.deepEqual(calls[1].argv.slice(0, 2), ["pane", "process-info"], "it typed without waiting for a shell");

  // THE SPACE, named for the agent an operator is looking for rather than an opaque process id.
  assert.deepEqual(calls[0].argv.slice(0, 3), ["workspace", "create", "--label"]);
  assert.equal(calls[0].argv[3], "aify-env comms-senior-dev");
  // ON THIS INSTANCE'S OWN HERDR. The wrong socket would drive the operator's ordinary Herdr.
  assert.equal(calls[0].socket, "C:/inv/herdr-tui.sock", "the space was opened on the wrong Herdr");

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
  const calls = [];
  const openPane = opener({ call: (bin, argv) => { calls.push(argv); return { result: { root_pane: { pane_id: "w9:p9" } } }; } });
  assert.equal(await openPane({ id: "headless", terminal: false }), null);
  assert.equal(await openPane({ id: "headless" }), null);
  assert.equal(await openPane(null), null);
  assert.deepEqual(calls, [], "a pane was opened onto a worker with no PTY");
});

test("A PANE THAT WILL NOT OPEN NEVER FAILS THE START", { skip }, async () => {
  const logs = [];
  const openPane = opener({ call: () => { throw new Error("Herdr said no"); }, log: m => logs.push(m) });
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

test("THE SECOND DEFECT: the space closes when its worker goes", { skip }, async () => {
  // TAKEN FROM THE RUNNER, not from the stop call, which is the whole reason this is wired where it
  // is: a worker killed from outside, or one that simply dies, must take its space with it too.
  const calls = [];
  const logs = [];
  const watched = new Map();
  const openPane = paneOpenerFor({
    env: { HERDR_SOCKET_PATH: "C:/inv/herdr-tui.sock" },
    base: "http://127.0.0.1:65000", node: "C:/node/node.exe", script: "C:/aify-env/bin/aify-env.mjs",
    cwd: "C:/work", log: m => logs.push(m), bin: "C:/herdr/herdr.exe",
    watchExit: (id, onExit) => watched.set(id, onExit),
    call: (_bin, argv) => {
      calls.push(argv);
      if (argv[1] === "process-info") return { result: { process_info: { shell_pid: 4242 } } };
      return { result: { root_pane: { pane_id: "w2:p1", workspace_id: "w2" }, workspace: { workspace_id: "w2" } } };
    },
  });

  const opened = await openPane({ id: "proc-1", label: "sc-tester", terminal: true });
  assert.equal(opened.workspaceId, "w2", "the opener never learned which space it made");
  assert.deepEqual([...watched.keys()], ["proc-1"], "nothing is watching the worker, so its space outlives it");

  // NOTHING CLOSES UNTIL THE WORKER ACTUALLY EXITS.
  assert.equal(calls.some(argv => argv[0] === "workspace" && argv[1] === "close"), false, "the space was closed while the worker ran");

  watched.get("proc-1")(0, null);
  assert.deepEqual(calls.at(-1), ["workspace", "close", "w2"], "the worker exited and its space stayed open");
  // THE SPACE, NOT THE PANE: `workspace create` made a space holding one pane, and closing the pane
  // alone leaves exactly the empty window that was reported.
  assert.ok(logs.some(l => l.includes("closed w2")), "a closed space said nothing");
});

test("A SPACE THAT WILL NOT CLOSE IS REPORTED, NEVER THROWN", { skip }, async () => {
  // This runs inside the Runner's exit notification, where a throw reaches a listener loop that has
  // other workers' business in it.
  const logs = [];
  const watched = new Map();
  let opened = false;
  const openPane = paneOpenerFor({
    env: { HERDR_SOCKET_PATH: "C:/inv/herdr-tui.sock" },
    base: "http://127.0.0.1:65000", node: "C:/node/node.exe", script: "C:/aify-env/bin/aify-env.mjs",
    cwd: "C:/work", log: m => logs.push(m), bin: "C:/herdr/herdr.exe",
    watchExit: (id, onExit) => watched.set(id, onExit),
    call: (_bin, argv) => {
      if (argv[0] === "workspace" && argv[1] === "close") throw new Error("already gone");
      if (argv[1] === "process-info") return { result: { process_info: { shell_pid: 7 } } };
      opened = true;
      return { result: { root_pane: { pane_id: "w4:p1", workspace_id: "w4" }, workspace: { workspace_id: "w4" } } };
    },
  });
  await openPane({ id: "proc-2", terminal: true });
  assert.equal(opened, true);
  watched.get("proc-2")(null, "SIGKILL");
  assert.ok(logs.some(l => l.includes("w4 outlived proc-2")), "a space that refused to close said nothing");
});

test("NOTHING IS WATCHED WHEN NO SPACE WAS OPENED", { skip }, async () => {
  // NEGATIVE CONTROL, driven by removing the thing under test. A watch registered for a worker with
  // no space would close whatever `workspaceId` happened to hold -- and with no opener at all, the
  // exit listener would be a leak on every headless worker this host runs.
  const watched = [];
  const watchExit = (id) => watched.push(id);
  const refused = opener({ call: () => { throw new Error("Herdr said no"); } });
  assert.equal(await refused({ id: "x", terminal: true }), null);

  const headless = paneOpenerFor({
    env: { HERDR_SOCKET_PATH: "C:/inv/herdr-tui.sock" }, base: "http://127.0.0.1:65000",
    node: "C:/node/node.exe", script: "C:/aify-env/bin/aify-env.mjs", bin: "C:/herdr/herdr.exe",
    watchExit, call: () => { throw new Error("never asked"); },
  });
  assert.equal(await headless({ id: "no-pty", terminal: false }), null);
  assert.deepEqual(watched, [], "an exit watch was registered for a worker that got no space");
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
  // space and closes none, which is the defect this half exists for and is invisible to every test
  // above -- they inject their own.
  assert.match(source, /watchExit: \(id, on\) => runner\.subscribe\(id, \(\) => \{\}, on\)/, "the opener learns no exit");
});
