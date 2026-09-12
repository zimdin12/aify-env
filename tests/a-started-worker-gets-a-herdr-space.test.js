// A worker started inside `herdr-aify env` gets a Herdr space, and one started anywhere else does not.
//
// THE DEFECT THIS EXISTS FOR, reported with the feature otherwise working: the operator started
// `comms-senior-dev` and `ef-manager` from the picker inside a dedicated instance. Both came up --
// "they started but i do not see new space in herdr. it should star one right ?" -- as ordinary
// children of a daemon that merely happened to live in a pane, which is indistinguishable from
// running outside Herdr. The spaces were the operator's entire reason for the mode: "lets that
// aify-env manage/spawn/kill other spaces".
//
// WHAT IS ASSERTED, and what deliberately is not. That a pane is opened for a terminal-backed worker
// this daemon started, that it ATTACHES rather than re-running the agent, that a failure to open one
// never fails the start, and that an ordinary daemon opens nothing. Herdr's own drawing is Herdr's.

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
      : { result: { root_pane: { pane_id: "w2:p1" } } })),
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
      : { result: { root_pane: { pane_id: "w2:p1" } } };
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
});
