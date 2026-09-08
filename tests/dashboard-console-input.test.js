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

const LF = String.fromCharCode(10);
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
/**
 * The daemon's answers, including a REAL output stream for the console.
 *
 * THE STREAM MATTERS NOW. Input is gated on the follower being LIVE as well as on a pane frame
 * having rendered -- a pane showing "connecting", an exit notice or a failure is a rendered frame
 * and still not a place to type. A fake that answered `/output` with JSON left every follower stuck
 * at `connecting`, so a test about FORWARDING was exercising a stream that never opened.
 */
const fakeFetch = (processes) => async (url) => {
  if (String(url).includes("/output")) {
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: (async function* body() {
        yield encoder.encode(`data: ${JSON.stringify("ready")}${LF}${LF}`);
        // Held open, like the real one: a console stream ends when the process does.
        await new Promise(() => {});
      })(),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => (String(url).includes("/health")
      ? { version: "0.0.0", processes }
      : { processes }),
  };
};

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
  // OPEN THE CONSOLE FIRST, through the real key path. The pane defaults to hidden and a hidden pane
  // opens no stream -- deliberately, because a stream nobody is reading is an HTTP connection and a
  // growing buffer for a pane that is not on screen. Pressing `p` here makes this test stronger than
  // it was: it now proves the whole chain from a keystroke to an opened stream, rather than assuming
  // the stream opens by itself.
  input.emit("data", "p");
  await new Promise((r) => setImmediate(r));
  stop();
  assert.ok(asked.some((u) => u.includes("/processes/p1/output")),
    `no stream was opened after opening the console: ${asked.join(", ")}`);
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
  // A FRAME HAS TO LAND FIRST, and this await is the test being honest rather than a workaround.
  // Input is gated on a pane frame having actually RENDERED -- not on the layout permitting one --
  // so a synchronous burst outruns the screen and is refused. At human typing speed the draw
  // triggered by the attach lands long before the next keystroke; this reproduces that, and a burst
  // that beats the frame is exactly the case the gate exists to refuse.
  // Long enough for the stream to OPEN, not just for a microtask: `start()` is deliberately not
  // awaited by the session (a render loop must not block on a connection), so the follower reaches
  // `streaming` a few tasks later.
  await new Promise((r) => setTimeout(r, 30));
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


test("A CONFIRMED ACTION REACHES onAction, through the real key path", async () => {
  // The end of the chain, driven the way an operator drives it: keystrokes into the live view, and a
  // handler that would be the thing actually killing a worker. Nothing between here and `keys.mjs` is
  // mocked, so the confirmation cannot be bypassed by a seam this test invented.
  const performed = [];
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    input,
    onAction: (p) => performed.push(p),
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));

  const DOWN_ = String.fromCharCode(27) + "[B";
  input.emit("data", DOWN_);          // select bravo
  input.emit("data", "m");            // open the menu
  input.emit("data", DOWN_);          // restart
  input.emit("data", DOWN_);          // stop
  input.emit("data", String.fromCharCode(13));
  assert.deepEqual(performed, [], "a stop reached the handler before it was confirmed");

  input.emit("data", "y");
  await new Promise((r) => setImmediate(r));
  stop();

  assert.equal(performed.length, 1, `expected one action, got ${performed.length}`);
  assert.equal(performed[0].action, "stop");
  assert.equal(performed[0].process.id, "p2", "the action named the wrong agent");
});

test("NEGATIVE CONTROL: with no handler the menu is inert and nothing throws", async () => {
  // The honest default while handlers are being built: the operator sees what is coming, nothing
  // happens, and nothing pretends to have happened. A `data` listener that threw here would take the
  // whole view down on a keypress.
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    input,
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  assert.doesNotThrow(() => {
    input.emit("data", "m");
    input.emit("data", String.fromCharCode(13));
  });
  stop();
});

console.log("dashboard-console-input.test.js: all assertions passed");
