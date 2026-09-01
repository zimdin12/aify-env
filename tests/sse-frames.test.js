// Reading the event stream the daemon writes for `GET /processes/:id/output`.
//
// THE FIXTURES ARE BUILT THE WAY THE SERVER BUILDS THEM -- `"data: " + JSON.stringify(chunk)` and a
// blank line -- rather than hand-typed, so a test cannot agree with a parser about a format neither
// shares with the thing that actually writes it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAME_EXIT,
  FRAME_OUTPUT,
  FRAME_UNREADABLE,
  parseFrame,
  readFrames,
} from "../lib/sse-frames.mjs";

const LF = String.fromCharCode(10);
const FRAME_END = LF + LF;

/** Exactly what bin/aify-env.mjs writes for a chunk of output. */
const outputFrame = (text) => `data: ${JSON.stringify(text)}${FRAME_END}`;
/** Exactly what it writes when the process exits. */
const exitFrame = (frame) => `event: exit${LF}data: ${JSON.stringify(frame)}${FRAME_END}`;

// -- parseFrame ----------------------------------------------------------------------------------

test("an output frame decodes to the text the process printed", () => {
  const frame = parseFrame('data: "hello"');
  assert.deepEqual(frame, { type: FRAME_OUTPUT, text: "hello" });
});

test("A NEWLINE INSIDE A CHUNK SURVIVES, which is the whole reason the wire is JSON", () => {
  // The blank line is the frame delimiter and a coding agent emits newlines constantly. A parser that
  // split on newlines without decoding would cut every multi-line chunk in half.
  const text = `line one${LF}line two${LF}`;
  const frame = parseFrame(`data: ${JSON.stringify(text)}`);
  assert.equal(frame.text, text);
});

test("the single space after the colon is stripped, and only that one", () => {
  // Per SSE. A parser that used `slice(5)` alone would prepend a space to every chunk; one that
  // trimmed would eat leading indentation, which is real output in a console.
  assert.equal(parseFrame('data: "  indented"').text, "  indented");
});

test("an exit frame is TYPED, so an exit is never printed as output", () => {
  // Without the event name a consumer reading `data:` frames as output would print `{"code":0}` as
  // though the process had said it.
  assert.deepEqual(parseFrame(`event: exit${LF}data: {"code":0}`), { type: FRAME_EXIT, code: 0 });
});

test("A NULL EXIT CODE IS PRESERVED -- it is what a signalled death looks like", () => {
  // Coercing it to 0 reports a killed process as one that exited cleanly. The server stopped doing
  // exactly that on 2026-08-26 and a consumer must not put it back.
  const frame = parseFrame(`event: exit${LF}data: {"code":null,"signal":"SIGKILL"}`);
  assert.equal(frame.code, null);
  assert.equal(frame.signal, "SIGKILL");
});

test("an absent signal stays ABSENT, so 'nothing killed it' is distinguishable", () => {
  const frame = parseFrame(`event: exit${LF}data: {"code":0}`);
  assert.equal("signal" in frame, false);
});

test("multiple data lines are joined per SSE, so a split payload FAILS LOUDLY", () => {
  // This server writes exactly one `data:` line per frame and its payload is JSON, which cannot
  // contain a raw newline -- so joined data lines can never form valid JSON here, and this case
  // should be impossible.
  //
  // It is still worth pinning what happens if it stops being impossible. Keeping only the LAST line
  // would silently decode a fragment as if it were the whole chunk; joining them yields something
  // that fails to parse, and a frame that fails to parse is REPORTED. I first asserted the join
  // produced usable text, which cannot happen: the assertion described a payload no encoder emits.
  const frame = parseFrame(`data: "a${LF}data: b"`);
  assert.equal(frame.type, FRAME_UNREADABLE);
  assert.match(frame.why, /not valid JSON/);
});

test("A FRAME THAT CANNOT BE READ IS REPORTED, never dropped", () => {
  // Dropping it makes a truncated or re-encoded stream look like a quiet process: the console shows
  // nothing and nobody can tell silence from a broken feed.
  const bad = parseFrame("data: {not json");
  assert.equal(bad.type, FRAME_UNREADABLE);
  assert.match(bad.why, /not valid JSON/);
  assert.ok(bad.raw.includes("not json"), "it carries what arrived, for diagnosis");
});

test("an output frame whose data is not a string is unreadable, not coerced", () => {
  const bad = parseFrame("data: 42");
  assert.equal(bad.type, FRAME_UNREADABLE);
  assert.match(bad.why, /not a string/);
});

test("an exit frame whose data is not an object is unreadable", () => {
  for (const payload of ['"gone"', "42", "[1,2]", "null"]) {
    const bad = parseFrame(`event: exit${LF}data: ${payload}`);
    assert.equal(bad.type, FRAME_UNREADABLE, `${payload} was accepted as an exit`);
  }
});

test("a frame with no data field carries nothing and is not invented into one", () => {
  assert.equal(parseFrame("event: exit"), null);
  assert.equal(parseFrame(": a comment"), null);
  assert.equal(parseFrame("id: 7"), null);
  assert.equal(parseFrame(""), null);
  assert.equal(parseFrame(null), null);
});

// -- readFrames ----------------------------------------------------------------------------------

test("whole frames in one chunk all arrive, in order", () => {
  const wire = outputFrame("one") + outputFrame("two") + outputFrame("three");
  const { frames, carry } = readFrames("", wire);
  assert.deepEqual(frames.map((f) => f.text), ["one", "two", "three"]);
  assert.equal(carry, "");
});

test("A FRAME SPLIT MID-JSON IS NOT PARSED EARLY", () => {
  // The dangerous case: a prefix of a JSON string can be valid JSON on its own, so a parser that
  // tried the incomplete text could SUCCEED and emit half a chunk as though it were whole.
  const wire = outputFrame("hello world");
  const cut = Math.floor(wire.length / 2);
  const first = readFrames("", wire.slice(0, cut));
  assert.deepEqual(first.frames, []);
  const second = readFrames(first.carry, wire.slice(cut));
  assert.deepEqual(second.frames.map((f) => f.text), ["hello world"]);
});

test("a frame split BETWEEN the event line and its data line still reads as an exit", () => {
  // A socket can break anywhere, including inside a multi-line frame. Splitting here used to be the
  // case that turned an exit into an output frame.
  const wire = exitFrame({ code: 3 });
  const at = wire.indexOf("data:");
  const first = readFrames("", wire.slice(0, at));
  const second = readFrames(first.carry, wire.slice(at));
  assert.deepEqual(second.frames, [{ type: FRAME_EXIT, code: 3 }]);
});

test("a frame split INSIDE the blank-line delimiter is still one frame", () => {
  // The delimiter is two characters and a chunk can land between them.
  const wire = outputFrame("x");
  const first = readFrames("", wire.slice(0, wire.length - 1));
  assert.deepEqual(first.frames, []);
  const second = readFrames(first.carry, wire.slice(-1));
  assert.deepEqual(second.frames.map((f) => f.text), ["x"]);
});

test("one byte at a time still yields exactly the frames that were sent", () => {
  // The strongest statement of the carry contract: no chunking can add, lose or reorder a frame.
  const wire = outputFrame("alpha") + exitFrame({ code: null, signal: "SIGTERM" });
  let carry = "";
  const got = [];
  for (const ch of wire) {
    const step = readFrames(carry, ch);
    carry = step.carry;
    got.push(...step.frames);
  }
  assert.deepEqual(got, [
    { type: FRAME_OUTPUT, text: "alpha" },
    { type: FRAME_EXIT, code: null, signal: "SIGTERM" },
  ]);
  assert.equal(carry, "");
});

test("output and exit arriving together keep their order", () => {
  // An exit that overtook the final output would show a console going quiet before its last line.
  const { frames } = readFrames("", outputFrame("last words") + exitFrame({ code: 0 }));
  assert.deepEqual(frames.map((f) => f.type), [FRAME_OUTPUT, FRAME_EXIT]);
});

test("an empty chunk changes nothing and does not throw", () => {
  assert.deepEqual(readFrames("", ""), { frames: [], carry: "" });
  assert.deepEqual(readFrames(null, null), { frames: [], carry: "" });
  assert.deepEqual(readFrames(undefined, undefined), { frames: [], carry: "" });
});

test("keep-alive blank lines between frames do not invent empty output", () => {
  // A stream may carry padding. Emitting an empty output frame for it would print blank lines into a
  // console that the process never wrote.
  const { frames } = readFrames("", FRAME_END + outputFrame("real") + FRAME_END);
  assert.deepEqual(frames.map((f) => f.text), ["real"]);
});

console.log("sse-frames.test.js: all assertions passed");
