// A2: what the daemon streams from a REAL managed agent must arrive at the pane as a terminal screen.
//
// A2 asked for control of a managed agent's TUI from aify-env, with herdr as the model: a persistent
// server plus a client that attaches to REAL terminals rather than redraws. All of that is built --
// `ConsoleSession` owns the selection and the follower, `OutputFollower` streams
// `/processes/:id/output`, `composeConsole` renders the pane, and `aify-env tui` POSTs keystrokes
// back to `/processes/:id/input`. The open design question, "whose PTY is it", answered itself on
// 2026-09-03: aify-env owns every managed PTY, because it starts them.
//
// SO THE MACHINERY WAS COMPLETE AND UNPROVEN, which is the same state A1 was in. Nothing exercised
// it against bytes a real claude actually sends -- every console test in this suite uses
// hand-written frames -- and that is the precise failure this project spent a night on: a green test
// describing the screen a person sees while the code reads what a terminal sends.
//
// THE FIXTURE IS A LIVE CAPTURE, taken from `sc-lead` on the operator's own host while it worked.
// Seven whole SSE frames, chosen small and control-sequence-only so the file carries no work text.
//
// WHAT IT PINS, and neither is visible with a hand-written frame:
//
//   1. THE WIRE IS JSON. Measured on that capture: the payload carries backslash-u-0-0-1-b as SIX
//      TEXT CHARACTERS, and the raw ESC byte 0x1b appears NOWHERE in 110KB of stream. A consumer
//      that forwards the data field without `JSON.parse` puts that literal escape text on the
//      operator's screen -- a console that looks broken while every component reports healthy.
//
//      Written out in words on purpose. The first draft of this comment SPELLED the escape and it
//      was interpreted on the way into the file: the sequence vanished, leaving an empty pair of
//      backticks, and the next line ended up carrying a real ESC byte invisible in a diff. A file
//      about escape handling is the worst place to lose an escape.
//
//   2. CLAUDE MOVES THE CURSOR INSTEAD OF PRINTING SPACES. `ESC[1C` is in this capture, and it is
//      the same fact that made a console-prompt matcher in aify-comms watch its dialog and do
//      nothing, with fourteen green tests written from what the screen LOOKS like.
//
// The negative control is what makes the first assertion mean anything: the fixture as stored has no
// ESC byte, so an ESC byte after decoding can only have come from the decode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FRAME_OUTPUT, readFrames } from "../lib/sse-frames.mjs";
import { applyFrame } from "../lib/output-follower.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, "fixtures", "claude-console-sse.raw.txt");

const ESC = String.fromCharCode(27);

function capture() {
  return readFileSync(CAPTURE, "utf8");
}

/** Everything the frames carry, in order, as the buffer would receive it. */
function decodedText() {
  const { frames } = readFrames("", capture());
  return frames
    .filter((frame) => frame?.type === FRAME_OUTPUT)
    .map((frame) => frame.text)
    .join("");
}

test("THE CAPTURE HAS NO ESCAPE BYTE — the negative control for everything below", () => {
  // Without this, "the decoded text contains ESC" could be satisfied by a reader that forwarded the
  // bytes untouched. The wire really is JSON-escaped, so an ESC byte downstream can only have come
  // from decoding it.
  const raw = capture();
  assert.ok(!raw.includes(ESC), "the fixture already holds ESC bytes, so it cannot prove a decode");
  assert.ok(raw.includes("\\u001b"), "the fixture is not JSON-escaped, so it is not what the wire sends");
});

test("the frames are read as OUTPUT, not as something unreadable", () => {
  // A capture the parser rejects would make every assertion below vacuous: `decodedText` would be
  // "" and contain no literal escapes either.
  const { frames } = readFrames("", capture());
  const outputs = frames.filter((f) => f?.type === FRAME_OUTPUT);
  assert.ok(outputs.length >= 5, `only ${outputs.length} output frame(s) parsed from a real capture`);
  assert.equal(frames.filter((f) => f?.type === "unreadable").length, 0,
    "a frame the daemon really sent was reported as unreadable");
});

test("A REAL FRAME DECODES TO A TERMINAL SCREEN", () => {
  const text = decodedText();
  assert.ok(text.includes(ESC),
    "the decoded output carries no ESC byte, so the pane would render the literal text \\u001b[...");
  assert.ok(!text.includes("\\u001b"),
    "the literal six characters survived into the pane, which is what a missing JSON.parse looks like");
});

test("CURSOR-FORWARD IS PRESENT, because claude does not print spaces", () => {
  // The fact that made an aify-comms prompt matcher fail silently: it looked for a string that is
  // never transmitted. Anything downstream that reasons about this screen -- a matcher, a search, a
  // width calculation -- has to expect ESC[1C where a person sees a gap.
  assert.ok(decodedText().includes(`${ESC}[1C`),
    "no cursor-forward in a real claude capture; the fixture may have been regenerated from a "
    + "different runtime, and anything reasoning about spacing should be re-checked");
});

test("applyFrame appends output and does not end the stream", () => {
  // The join between parsing and the buffer, driven with real frames rather than hand-written ones.
  const appended = [];
  const buffer = { append: (text) => appended.push(text) };
  const { frames } = readFrames("", capture());
  let done = false;
  let unreadable = 0;
  for (const frame of frames) {
    const result = applyFrame(buffer, frame);
    done = done || result.done;
    unreadable += result.unreadable;
  }
  assert.equal(done, false, "a live console reported its process as exited");
  assert.equal(unreadable, 0);
  assert.ok(appended.length >= 5, `only ${appended.length} chunk(s) reached the buffer`);
  assert.ok(appended.join("").includes(ESC), "the buffer received escape-free text");
});

test("a frame split across reads is not lost", () => {
  // The follower feeds `#consume` whatever a socket chunk happened to contain, so a frame boundary
  // lands mid-frame routinely. `readFrames` carries the remainder; a reader that dropped it would
  // lose a chunk of the operator's console at random and look like a quiet process.
  const raw = capture();
  const cut = Math.floor(raw.length / 2);
  const first = readFrames("", raw.slice(0, cut));
  const second = readFrames(first.carry, raw.slice(cut));
  const split = [...first.frames, ...second.frames]
    .filter((f) => f?.type === FRAME_OUTPUT).map((f) => f.text).join("");
  assert.equal(split, decodedText(), "splitting the stream changed what reached the pane");
});
