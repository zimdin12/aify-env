// The live view gives the operator's terminal back however the process ends.
//
// THE DEFECT (v0.7.1 review, E2). Since the view draws on the alternate screen with the cursor hidden,
// only `q` and the two signal handlers in `aify-env tui` gave the screen back. Any uncaught exception,
// and Ctrl+Break on Windows (SIGBREAK, which the tui did not listen for), left the operator's shell on
// the alternate screen with no cursor and raw mode on. The daemon renders the same view, so an
// exception there did the same.
//
// THE REPAIR LIVES IN THE VIEW, so both callers get it: once a live view has taken the screen it
// releases it from the process's `exit` event, which node emits for `process.exit`, for a drained
// loop, and for an uncaught exception or rejection -- measured in the out-of-process case below.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startDashboard } from "../lib/dashboard.mjs";
import { LEAVE_VIEW } from "../lib/frame.mjs";
import { LEAVING_SIGNALS } from "../lib/view-exit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

class FakeInput extends EventEmitter {
  constructor() { super(); this.raw = []; }
  setRawMode(on) { this.raw.push(on); return this; }
  resume() { return this; }
  pause() { return this; }
}

const SNAPSHOT_FETCH = async () => ({ ok: true, status: 200, body: null, json: async () => ({ processes: [] }) });

async function liveView(extra = {}) {
  const writes = [];
  const input = new FakeInput();
  const proc = new EventEmitter();
  const view = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: (text) => writes.push(text),
    clearScreen: true,
    intervalMs: 60_000,
    input,
    processEvents: proc,
    fetchImpl: SNAPSHOT_FETCH,
    readFile: () => { throw new Error("no registry"); },
    ...extra,
  });
  return { view, writes, input, proc };
}

test("a process ending by any path releases a live view's screen and keyboard", async (t) => {
  const { view, writes, input, proc } = await liveView();
  t.after(() => view.stop());
  assert.ok(writes.join("").length > 0, "positive control: the view drew nothing");
  proc.emit("exit", 1);
  assert.ok(writes.at(-1).includes(LEAVE_VIEW), "the alternate screen was not left on exit");
  assert.equal(input.raw.at(-1), false, "raw mode was left on");
});

test("a view that was stopped leaves no exit listener behind", async () => {
  const { view, proc } = await liveView();
  assert.equal(proc.listenerCount("exit"), 1, "positive control: nothing was listening for the exit");
  view.stop();
  assert.equal(proc.listenerCount("exit"), 0);
});

test("CONTROL: a one-shot render takes no screen and listens for nothing", async () => {
  const { proc } = await liveView({ once: true });
  assert.equal(proc.listenerCount("exit"), 0);
});

test("an uncaught exception in the process still hands the screen back", () => {
  // OUT OF PROCESS, because only a real process has a real uncaught exception. The write is
  // synchronous so the bytes are not lost to an exiting process's asynchronous stdout.
  const dashboard = pathToFileURL(path.join(HERE, "..", "lib", "dashboard.mjs")).href;
  const script = `
    import { writeSync } from "node:fs";
    import { startDashboard } from ${JSON.stringify(dashboard)};
    await startDashboard({
      endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
      write: (text) => writeSync(1, text), clearScreen: true, intervalMs: 60000,
      fetchImpl: async () => ({ ok: true, status: 200, body: null, json: async () => ({ processes: [] }) }),
      readFile: () => { throw new Error("no registry"); },
    });
    setTimeout(() => { throw new Error("an uncaught failure"); }, 5);
  `;
  let out = "";
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    out = String(error.stdout ?? "");
    assert.match(String(error.stderr ?? ""), /an uncaught failure/, "positive control: the process did not die of the exception");
  }
  assert.ok(out.includes("[?1049h"), `positive control: the view never took the screen: ${JSON.stringify(out.slice(0, 80))}`);
  assert.ok(out.endsWith(LEAVE_VIEW), `the screen was not handed back: ${JSON.stringify(out.slice(-40))}`);
});

test("aify-env tui leaves on Ctrl+Break and a hangup as well as SIGINT and SIGTERM", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    assert.ok(LEAVING_SIGNALS.includes(signal), `${signal} is not a way out of the view`);
  }
  // THE ENTRYPOINT CANNOT BE RUN HERE -- running it starts a view that talks to a daemon -- so this
  // asserts it takes its signals from the list above rather than a second one of its own.
  const source = readFileSync(path.join(HERE, "..", "bin", "aify-env-tui.mjs"), "utf8");
  assert.match(source, /for \(const signal of LEAVING_SIGNALS\)/);
});
