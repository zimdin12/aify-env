// The one part of the console that touches the operator's terminal.
//
// RAW MODE IS BORROWED, NOT OWNED. A view that exits leaving the terminal raw hands back a shell that
// no longer echoes what is typed, and the fix is not obvious to anyone it happens to. So most of this
// file is about giving it back, on every path out.
//
// AND THE CONSOLE IS OPT-IN. `startDashboard` is called by a script with `--once`, by tests, and by the
// daemon's own startup banner. None of those owns a keyboard, and a view that opened a process stream
// because it happened to be imported would be doing IO nobody asked for.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { startDashboard } from "../lib/dashboard.mjs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);
const ENTER = String.fromCharCode(13);

/** A stand-in for process.stdin that records what was done to it. */
class FakeInput extends EventEmitter {
  constructor({ isRaw = false } = {}) {
    super();
    this.isRaw = isRaw;
    this.calls = [];
  }

  setRawMode(on) { this.calls.push(`raw:${on}`); this.isRaw = on; return this; }
  resume() { this.calls.push("resume"); return this; }
  pause() { this.calls.push("pause"); return this; }
}

/** A daemon that answers the one call collectSnapshot makes, with the given processes. */
const fakeFetch = (processes) => async (url) => ({
  ok: true,
  status: 200,
  json: async () => (String(url).includes("/health")
    ? { version: "0.0.0", processes }
    : { processes }),
});

const start = (input, extra = {}) => startDashboard({
  endpoint: "http://127.0.0.2:1",
  registryPath: "/nonexistent/services.json",
  write: () => {},
  clearScreen: false,
  intervalMs: 60_000,
  columns: 120,
  rows: 20,
  input,
  fetchImpl: fakeFetch([{ id: "p1", label: "one" }, { id: "p2", label: "two" }]),
  readFile: () => { throw new Error("no registry"); },
  ...extra,
});

test("WITHOUT `input` NO PROCESS STREAM IS OPENED", async () => {
  // The daemon banner and `--once` both land here, and neither owns a keyboard. Opening a console
  // stream for a script is IO nobody asked for.
  //
  // THIS TEST USED TO BE VACUOUS. It built a FakeInput, never passed it, and asserted nothing had
  // been done to it -- true no matter what the code did. A mutation removing the `input ?` guard
  // survived it, and that mutation makes every `--once` render subscribe to a process. So the
  // assertion is now about the CONSEQUENCE: which URLs were fetched.
  const asked = [];
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => ({ processes: [{ id: "p1", label: "one" }] }) };
    },
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  stop();
  const streams = asked.filter((u) => u.includes("/output"));
  assert.deepEqual(streams, [], `a console stream was opened with no input: ${streams.join(", ")}`);
  // POSITIVE CONTROL: the snapshot request DID happen, so an empty stream list means "none opened"
  // rather than "nothing was fetched at all".
  assert.ok(asked.length > 0, "no request was made at all -- this test proves nothing");
});

test("WITH `input` a process stream IS opened, which is what makes the test above mean something", async () => {
  const asked = [];
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    input,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return {
        ok: true,
        status: 200,
        body: null,
        json: async () => ({ processes: [{ id: "p1", label: "one" }] }),
      };
    },
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  stop();
  assert.ok(asked.some((u) => u.includes("/processes/p1/output")),
    `no stream was opened for the selection: ${asked.join(", ")}`);
});

test("with `input` the terminal goes raw, and stop() GIVES IT BACK", async () => {
  const input = new FakeInput({ isRaw: false });
  const { stop } = await start(input);
  assert.ok(input.calls.includes("raw:true"), "raw mode was never entered");
  stop();
  assert.ok(input.calls.includes("raw:false"), "raw mode was never restored");
  assert.equal(input.isRaw, false);
});

test("A TERMINAL ALREADY IN RAW MODE IS LEFT IN IT", async () => {
  // We borrowed nothing, so we return nothing. Turning it off would break whatever set it -- the
  // caller may be a wrapper that owns the mode for its own reasons.
  const input = new FakeInput({ isRaw: true });
  const { stop } = await start(input);
  stop();
  assert.ok(!input.calls.includes("raw:false"), "raw mode was turned off for a caller that owned it");
});

test("stop() removes the listener, so a late keypress cannot reach a stopped view", async () => {
  const input = new FakeInput();
  const { stop } = await start(input);
  assert.equal(input.listenerCount("data"), 1);
  stop();
  assert.equal(input.listenerCount("data"), 0);
});

test("stop() is safe to call twice", async () => {
  const input = new FakeInput();
  const { stop } = await start(input);
  stop();
  assert.doesNotThrow(() => stop());
});

test("a quit key calls onQuit rather than exiting from inside the library", async () => {
  // lib/ owns no lifecycle on purpose: the daemon's interrupt has to be able to stop its managed
  // processes rather than being pre-empted by a view's exit handler.
  let quit = 0;
  const input = new FakeInput();
  const { stop } = await start(input, { onQuit: () => { quit += 1; } });
  input.emit("data", CTRL_C);
  stop();
  assert.equal(quit, 1);
});

test("keys meant for a process are HANDED BACK, not written from inside the view", async () => {
  // Writing into a PTY is the daemon's business. A view asks.
  const sent = [];
  const input = new FakeInput();
  const { stop } = await start(input, { onInput: (target, data) => sent.push([target?.id, data]) });
  input.emit("data", ENTER);   // attach
  input.emit("data", "hello");
  stop();
  assert.deepEqual(sent, [["p1", "hello"]]);
});

test("moving the selection does not call onInput", async () => {
  // An arrow key is three bytes. Routing it to the process would type escape sequences at an agent.
  const sent = [];
  const input = new FakeInput();
  const { stop } = await start(input, { onInput: (target, data) => sent.push([target?.id, data]) });
  input.emit("data", DOWN);
  stop();
  assert.deepEqual(sent, []);
});

test("a handler that throws does not take the view down", async () => {
  const input = new FakeInput();
  const { stop } = await start(input, { onQuit: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => input.emit("data", CTRL_C));
  stop();
});

console.log("dashboard-console-input.test.js: all assertions passed");
