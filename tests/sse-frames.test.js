// Reading the event stream the daemon writes for `GET /processes/:id/output`.
//
// THE FIXTURES ARE BUILT THE WAY THE SERVER BUILDS THEM -- `"data: " + JSON.stringify(chunk)` and a
// blank line -- rather than hand-typed, so a test cannot agree with a parser about a format neither
// shares with the thing that actually writes it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  FRAME_EXIT,
  FRAME_META,
  FRAME_OUTPUT,
  FRAME_UNREADABLE,
  dataFrame,
  exitFrame as writeExitFrame,
  namedFrame,
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

// -- WRITING, and the round trip that holds the two halves to each other --------------------------
//
// THE WRITERS MOVED IN HERE ON 2026-09-08. They were comments inside the route, then briefly a
// separate module, and neither could be held to the parser above: this file's own header used to
// DESCRIBE the wire format in prose, which is two copies of one fact with a route between them. The
// round-trip test below is the thing that makes them one.

test("A NEWLINE IN THE OUTPUT DOES NOT END THE FRAME, which is why the payload is encoded", () => {
  // The writer's side of the rule the parser above already depends on. A newline is the delimiter, so
  // writing output raw would split one chunk into two frames -- and a process printing a BLANK LINE
  // would emit a frame terminator in the middle of its own output.
  const frame = dataFrame(`first${LF}${LF}second`);
  assert.equal(frame.split(FRAME_END).length, 2, "the output ended the frame early");
});

test("A NAMED FRAME IS INVISIBLE to a consumer that reads only `data:` as output", () => {
  // The compatibility argument this protocol adds facts under: `exit` arrived this way, and so does
  // the `meta` frame that tells a console the producer's geometry.
  const frame = namedFrame("meta", { cols: 132, rows: 40, truncated: false });
  assert.ok(frame.startsWith(`event: meta${LF}`), `a named frame must lead with its name: ${frame}`);
});

test("`signal` IS OMITTED RATHER THAN SENT EMPTY, so 'nothing killed it' stays distinguishable", () => {
  // An empty string is a THIRD state a consumer has to interpret, and the one it would most likely
  // read as "killed by something I have no name for". The parser above asserts the reading half.
  const clean = JSON.parse(writeExitFrame(0, "").split(LF)[1].slice("data: ".length));
  assert.deepEqual(clean, { code: 0 });
});

test("EVERYTHING THIS FILE WRITES, THIS FILE READS BACK -- byte for byte, one byte at a time", () => {
  // THE AGREEMENT TEST, and the reason the two halves are neighbours. Each assertion above pins one
  // side of the format; only this one fails when they drift APART. It feeds the writers' own output
  // through the reader a byte at a time, so no chunking can hide a disagreement.
  const awkward = [
    "plain",
    `two${LF}lines`,
    `a blank line${LF}${LF}in the middle`,
    'quotes " and backslashes \ and a colon: here',
    "data: not actually a frame",
    `event: exit${LF}data: {"code":0}`,   // output that LOOKS like an exit frame
  ];
  const wire = awkward.map(dataFrame).join("") + writeExitFrame(null, "SIGKILL");

  let carry = "";
  const got = [];
  for (const ch of wire) {
    const step = readFrames(carry, ch);
    carry = step.carry;
    got.push(...step.frames);
  }
  assert.equal(carry, "", "the stream did not end on a frame boundary");
  assert.deepEqual(got.slice(0, -1).map((f) => f.type), awkward.map(() => FRAME_OUTPUT),
    "written output came back as something other than output");
  assert.deepEqual(got.slice(0, -1).map((f) => f.text), awkward,
    "a payload did not survive the round trip");
  assert.deepEqual(got.at(-1), { type: FRAME_EXIT, code: null, signal: "SIGKILL" });
});

test("A META FRAME ROUND-TRIPS, and it did NOT when the writer shipped without the reader", () => {
  // THE DEFECT THIS PINS, measured before it was fixed: `namedFrame("meta", {...})` came back as
  // `{type:"unreadable", why:"an output frame whose data was not a string"}`. Meta carries an OBJECT,
  // like exit and unlike output, and the parser had no branch for it -- so every stream would have
  // opened with an unreadable frame, which this protocol REPORTS rather than drops. A console would
  // have led with an error on every attach.
  //
  // The agreement test below existed and did not catch it, because it checked the frame's PREFIX and
  // never fed one back through the parser. A field is not shipped until BOTH ends are proven.
  const { frames } = readFrames("", namedFrame("meta", {
    cols: 132, rows: 40, truncated: true, resized: false, replayBytes: 65536,
  }));
  assert.deepEqual(frames, [{
    type: FRAME_META, cols: 132, rows: 40, truncated: true, resized: false, replayBytes: 65536,
  }]);
});

test("A META FRAME THAT DOES NOT MENTION A RESIZE IS READ AS ONE, not as a stable geometry", () => {
  // THE SAME FAIL-CLOSED RULE `truncated` FOLLOWS, and it has to be, because the two say the same
  // thing about the same replay: these bytes cannot rebuild the positioned screen. A daemon too old
  // to send the field is exactly the daemon whose resizes nobody was tracking, so silence must not
  // read as "the geometry held".
  //
  // MEASURED against the real parser: 60 characters and an `O` written at 80 columns, then a resize
  // to 40. The terminal reflows and shows one row; the same bytes replayed into a 40-column emulator
  // put the `O` on row two. Both screens are coherent and only one is what the process sees.
  const [silent] = readFrames("", namedFrame("meta", { cols: 132, rows: 40, truncated: false })).frames;
  assert.equal(silent.resized, true, "a frame that said nothing about a resize was read as saying none happened");
  for (const value of ["no", null, 0, ""]) {
    const [odd] = readFrames("", namedFrame("meta", { cols: 1, rows: 1, truncated: false, resized: value })).frames;
    assert.equal(odd.resized, true, `${JSON.stringify(value)} was read as a claim that geometry held`);
  }
  // POSITIVE CONTROL: a literal `false` IS a claim, and is believed.
  const [claimed] = readFrames("", namedFrame("meta", { cols: 1, rows: 1, truncated: false, resized: false })).frames;
  assert.equal(claimed.resized, false);
});

test("meta NUMBERS ARE COERCED ONCE, here, and zero survives as a real answer", () => {
  // A consumer sizing an emulator from the string "132" builds a one-column screen and paints every
  // row into it. And 0 is not a missing value: a piped process has no terminal and therefore no size,
  // so it must not be defaulted away into an invented 80.
  const [strings] = readFrames("", namedFrame("meta", {
    cols: "132", rows: "40", truncated: "yes", replayBytes: "65536",
  })).frames;
  assert.equal(strings.cols, 132);
  assert.equal(strings.rows, 40);
  // FAILS CLOSED, and this assertion changed direction on 2026-09-08. It used to require a
  // non-boolean to become `false` -- which is a COMPLETENESS CLAIM, the most dangerous of the three
  // answers, made on the strength of a field nobody set. "We were not told" now becomes `true`:
  // unsound until a full reset, which cannot disclose anything.
  assert.equal(strings.truncated, true, "a frame that did not say was read as saying 'complete'");

  const [piped] = readFrames("", namedFrame("meta", { cols: 0, rows: 0 })).frames;
  assert.equal(piped.cols, 0);
  assert.equal(piped.rows, 0);
});

test("a meta frame whose data is not an object is unreadable, not coerced", () => {
  for (const payload of ['"132x40"', "42", "[132,40]", "null"]) {
    const [frame] = readFrames("", `event: meta${LF}data: ${payload}${FRAME_END}`).frames;
    assert.equal(frame.type, FRAME_UNREADABLE, `${payload} was accepted as meta`);
  }
});

test("NEGATIVE CONTROL: the round trip can FAIL, so passing it means something", () => {
  // If the reader accepted anything, the agreement above would hold against a broken writer. A frame
  // written WITHOUT encoding is exactly the mistake that rule exists to prevent, and the reader must
  // refuse it rather than quietly returning half a chunk.
  const raw = `data: two${LF}lines${FRAME_END}`;
  const { frames } = readFrames("", raw);
  assert.notDeepEqual(frames.map((f) => f.text), [`two${LF}lines`],
    "an unencoded payload round-tripped, so the encoding rule is not actually enforced");
});
