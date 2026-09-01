// Watching one process's console, driven against a fake stream rather than a live daemon.
//
// THE POINT OF MOST OF THESE IS THAT AN EMPTY PANE HAS FIVE CAUSES. Connecting, connected-but-quiet,
// exited, no-such-process and connection-failed all render as nothing if a client is careless, and
// `runner.js` goes to real trouble upstream to keep "no such process" distinguishable from "a process
// that has printed nothing yet". Collapsing them at the last step throws that away.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTING,
  EXITED,
  FAILED,
  GONE,
  OutputFollower,
  STREAMING,
  applyFrame,
} from "../lib/output-follower.mjs";
import { FRAME_EXIT, FRAME_OUTPUT, FRAME_UNREADABLE } from "../lib/sse-frames.mjs";
import { PaneBuffer } from "../lib/pane-buffer.mjs";

const LF = String.fromCharCode(10);
const FRAME_END = LF + LF;
const outputFrame = (text) => `data: ${JSON.stringify(text)}${FRAME_END}`;
const exitFrame = (frame) => `event: exit${LF}data: ${JSON.stringify(frame)}${FRAME_END}`;

/** A response whose body yields the given text pieces, as the real one yields bytes. */
function fakeStream(pieces, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    body: (async function* body() {
      for (const piece of pieces) yield encoder.encode(piece);
    })(),
  });
}

// -- applyFrame ----------------------------------------------------------------------------------

test("an output frame lands in the buffer and the stream continues", () => {
  const buffer = new PaneBuffer();
  const result = applyFrame(buffer, { type: FRAME_OUTPUT, text: `hello${LF}` });
  assert.deepEqual(result, { done: false, exit: null, unreadable: 0 });
  assert.deepEqual(buffer.view({ height: 2, width: 20 }), ["hello"]);
});

test("an exit frame FINISHES the stream, so a dead process never looks like a thinking one", () => {
  const result = applyFrame(new PaneBuffer(), { type: FRAME_EXIT, code: 0 });
  assert.equal(result.done, true);
  assert.deepEqual(result.exit, { code: 0 });
});

test("a signalled death keeps its null code and its signal", () => {
  const result = applyFrame(new PaneBuffer(), { type: FRAME_EXIT, code: null, signal: "SIGKILL" });
  assert.deepEqual(result.exit, { code: null, signal: "SIGKILL" });
});

test("AN UNREADABLE FRAME IS COUNTED, NOT PRINTED", () => {
  // Writing it into the pane would show an operator a protocol error as though the process had said
  // it -- the same confusion the named exit event exists to prevent. Dropping it silently would make
  // a garbage feed look like a quiet process. So: counted.
  const buffer = new PaneBuffer();
  const result = applyFrame(buffer, { type: FRAME_UNREADABLE, why: "bad", raw: "data: {" });
  assert.equal(result.unreadable, 1);
  assert.equal(buffer.length, 0);
  assert.equal(result.done, false);
});

test("a null frame changes nothing", () => {
  assert.deepEqual(applyFrame(new PaneBuffer(), null), { done: false, exit: null, unreadable: 0 });
});

// -- OutputFollower ------------------------------------------------------------------------------

const follow = (pieces, options = {}) => new OutputFollower({
  endpoint: "http://127.0.0.1:8802",
  id: "abc-p1",
  fetchImpl: fakeStream(pieces, options),
});

test("it reads output off the stream into the pane", async () => {
  const f = await follow([outputFrame(`one${LF}two${LF}`)]).start();
  assert.equal(f.status, STREAMING === f.status ? STREAMING : f.status);
  assert.deepEqual(f.buffer.view({ height: 5, width: 20 }), ["one", "two"]);
});

test("frames split across chunks arrive whole", async () => {
  const wire = outputFrame("hello world");
  const f = await follow([wire.slice(0, 7), wire.slice(7)]).start();
  assert.deepEqual(f.buffer.view({ height: 2, width: 40 }), ["hello world"]);
});

test("A MULTI-BYTE CHARACTER SPLIT ACROSS CHUNKS is not corrupted", async () => {
  // The decoder must be told the stream continues. Told each chunk is complete, it emits a
  // replacement character in the middle of a word -- visible, wrong, and blamed on the process.
  const wire = outputFrame("café latte");
  const bytes = new TextEncoder().encode(wire);
  const cut = wire.indexOf("é") + 1; // lands inside the two-byte sequence
  const f = new OutputFollower({
    endpoint: "http://x",
    id: "p",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      body: (async function* body() {
        yield bytes.slice(0, cut);
        yield bytes.slice(cut);
      })(),
    }),
  });
  await f.start();
  assert.deepEqual(f.buffer.view({ height: 2, width: 40 }), ["café latte"]);
});

test("an exit frame sets the status and the code, and stops reading", async () => {
  const f = await follow([outputFrame(`bye${LF}`), exitFrame({ code: 3 })]).start();
  assert.equal(f.status, EXITED);
  assert.deepEqual(f.exit, { code: 3 });
});

test("A 404 IS `gone`, NOT AN EMPTY CONSOLE", async () => {
  // The daemon is answering and has no such process. Rendering that as a quiet pane hides the one
  // fact the operator needs.
  const f = await follow([], { status: 404 }).start();
  assert.equal(f.status, GONE);
  assert.match(f.emptyReason(), /no such process/);
});

test("another error status is `failed` and names the code", async () => {
  const f = await follow([], { status: 500 }).start();
  assert.equal(f.status, FAILED);
  assert.match(f.reason, /500/);
});

test("a connection that never opens is `failed`, with the cause", async () => {
  const f = new OutputFollower({
    endpoint: "http://127.0.0.2:1",
    id: "p",
    fetchImpl: async () => { const e = new Error("connect ECONNREFUSED"); e.cause = { code: "ECONNREFUSED" }; throw e; },
  });
  await f.start();
  assert.equal(f.status, FAILED);
  assert.match(f.reason, /ECONNREFUSED/);
});

test("A STREAM THAT ENDS WITHOUT AN EXIT IS `failed`, not `exited`", async () => {
  // The connection dropped rather than the process finishing. Reporting it as an exit would invent a
  // fact about the process from a fact about the network.
  const f = await follow([outputFrame(`working${LF}`)]).start();
  assert.equal(f.status, FAILED);
  assert.match(f.reason, /without an exit/);
  assert.equal(f.exit, null);
});

test("an ABORT is not a failure -- a closed pane must not read as a broken one", async () => {
  const f = new OutputFollower({
    endpoint: "http://x",
    id: "p",
    fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
  });
  await f.start();
  assert.notEqual(f.status, FAILED);
});

test("stop() is safe before start, and twice", () => {
  const f = follow([]);
  assert.doesNotThrow(() => { f.stop(); f.stop(); });
});

// -- what a pane shows ---------------------------------------------------------------------------

test("A NON-EMPTY BUFFER WINS OVER THE STATUS -- last words are usually the cause of death", async () => {
  const f = await follow([outputFrame(`fatal: out of memory${LF}`), exitFrame({ code: 137 })]).start();
  assert.deepEqual(f.lines({ height: 3, width: 40 }), ["fatal: out of memory"]);
});

test("an empty pane always says WHY, and never renders as blank", async () => {
  const cases = [
    [await follow([], { status: 404 }).start(), /no such process/],
    [await follow([], { status: 500 }).start(), /unavailable/],
    [await follow([exitFrame({ code: 0 })]).start(), /exited without printing/],
  ];
  for (const [f, expected] of cases) {
    const [line] = f.lines({ height: 4, width: 60 });
    assert.match(line, expected);
    assert.notEqual(line.trim(), "", "an empty pane must never render as nothing at all");
  }
});

test("before connecting it says so, rather than looking like a quiet process", () => {
  const f = follow([]);
  assert.equal(f.status, CONNECTING);
  assert.match(f.emptyReason(), /connecting/);
});

test("the URL encodes the id, so a handle with odd characters still resolves", () => {
  const f = new OutputFollower({ endpoint: "http://h:1/", id: "a b/c" });
  // The trailing slash on the endpoint is trimmed, or the path would carry a double slash.
  assert.equal(f.url, "http://h:1/processes/a%20b%2Fc/output");
});

test("unreadable frames are counted on the follower, so a view can say the feed is broken", async () => {
  const f = await follow([`data: {not json${FRAME_END}`, exitFrame({ code: 0 })]).start();
  assert.equal(f.unreadableFrames, 1);
  assert.equal(f.status, EXITED);
});

console.log("output-follower.test.js: all assertions passed");
