#!/usr/bin/env node
// A pane that cannot render a picture must say so, not paint fragments.
//
// THE OPERATOR SAW IT, 2026-09-07. The right-hand pane of a live `aify-env tui` read:
//
//     Cited file didn't exist.—eflaggedCtheTbrokentpointer
//     · Misting… (5m 45s)
//         insurance, not mis_llocated effort.
//
// Text from different screen positions concatenated onto single rows. NOT a width bug and not a
// clipping bug: `pane-buffer.mjs` models a LOG -- newline ends a line, carriage return moves to
// column 0 -- and a coding agent paints a PICTURE with `ESC[row;colH` and `ESC[K`. Replaying a paint
// into a line model concatenates fragments that were never on the same row. It could not have worked.
//
// AIFY-COMMS ALREADY LEARNED THIS, one repo over. `service/api_core/console_prompts.py`: "claude does
// not send spaces, it moves the cursor ... a matcher run on raw bytes is looking for a string that is
// never transmitted. It watched the dialog it was written for and did nothing, with every one of its
// tests green." That is why the service renders through pyte. This pane has no emulator.
//
// AND ATTACH ALREADY WORKS. The operator verified it the same day against a claude worker and a
// hermes worker, because attach pipes bytes to a REAL terminal, which emulates them. So the honest
// pane points at the thing that works rather than showing a scramble that looks like a broken agent.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PaneBuffer } from "../lib/pane-buffer.mjs";
import { drawsWithCursor } from "../lib/process-registry.mjs";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const NOW = 1_800_000_000_000;

const seen = (buffer, at = NOW) => buffer.view({ height: 10, width: 60, nowMs: at }).join("\n");

// ── the detector ────────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: ordinary output is not painting", () => {
  // Every assertion below is "this pane refuses to render". A detector that answered true for
  // everything would satisfy them all and silently replace every pane with a notice.
  assert.equal(drawsWithCursor("building...\nok\n"), false);
  assert.equal(drawsWithCursor(`npm WARN deprecated${CR}`), false);
});

test("a CR spinner is NOT painting — this buffer models that correctly", () => {
  // `\r` moves to column 0 and the buffer already handles it. Treating it as a paint would replace
  // every progress bar in the world with a notice.
  assert.equal(drawsWithCursor(`Working.${CR}Working..${CR}Working...`), false);
});

test("COLOUR is not painting either", () => {
  // SGR leaves text in the order it was written; only movement and erasure break reading order.
  assert.equal(drawsWithCursor(`${ESC}[2mdim${ESC}[0m plain`), false);
});

test("positioning and erasing ARE painting", () => {
  assert.equal(drawsWithCursor(`${ESC}[12;40Hdrawn here`), true);
  assert.equal(drawsWithCursor(`${ESC}[Kwiped`), true);
  assert.equal(drawsWithCursor(`${ESC}[2J${ESC}[H`), true);
  assert.equal(drawsWithCursor(`up${ESC}[3A`), true);
});

test("a real claude frame is recognised", () => {
  // Shaped like the capture this repo keeps: cursor moves interleaved with styled text, which is
  // what produced the operator's scramble.
  const frame = `${ESC}[?25l${ESC}[21;3H${ESC}[38;2;220;129;97mGallivanting…${ESC}[24;3H${ESC}[?25h`;
  assert.equal(drawsWithCursor(frame), true);
});

// ── what the pane shows ─────────────────────────────────────────────────────────────────────────

test("A LOG STILL RENDERS AS LINES", () => {
  // The case that must not regress. Most processes are not TUIs, and their output is the reason the
  // pane exists at all.
  const b = new PaneBuffer();
  b.append("first line\nsecond line\n");
  const out = seen(b);
  assert.match(out, /first line/);
  assert.match(out, /second line/);
  assert.doesNotMatch(out, /cannot draw/);
});

test("A PAINTED SCREEN SHOWS A NOTICE, not fragments", () => {
  const b = new PaneBuffer();
  b.append("starting up\n");
  b.append(`${ESC}[12;40Hfragment A${ESC}[3;1Hfragment B`, { nowMs: NOW });
  const out = seen(b);
  assert.match(out, /cannot draw/, "the pane is still painting fragments");
  assert.match(out, /attach/, "the notice does not name the thing that does work");
  assert.doesNotMatch(out, /fragment A|fragment B/, "screen fragments reached the pane");
});

test("IT IS THE CONTENT, NOT A LATCH AND NOT A CLOCK", () => {
  // A process that paints a banner at startup and then logs is a log again -- but only once the
  // painted output has SCROLLED OUT of what the pane retains. Latching would cost it a pane it could
  // legitimately have; expiring on a timer released the very escape the notice was hiding, with no
  // new output at all (review measured that at N+30000 versus N+30001). Asking the content answers
  // both with one rule.
  const b = new PaneBuffer({ maxLines: 5 });
  b.append(`${ESC}[2J${ESC}[Hbanner\n`);
  assert.match(seen(b), /cannot draw/, "the banner was not recognised as a paint");

  b.append("still holding the banner\n");
  assert.match(seen(b), /cannot draw/,
    "the pane was released while the painted bytes were still in the buffer");

  for (let i = 0; i < 8; i += 1) b.append(`log line ${i}\n`);
  assert.match(seen(b), /log line 7/,
    "a process that stopped painting never got its pane back once the paint scrolled out");
});

test("the notice fits the pane it is given", () => {
  // It goes in the same narrow column as everything else; a notice that overflowed would be the
  // very defect this pane is being fixed for.
  const b = new PaneBuffer();
  b.append(`${ESC}[9;9Hx`, { nowMs: NOW });
  for (const width of [12, 24, 80]) {
    for (const line of b.view({ height: 10, width, nowMs: NOW })) {
      assert.ok(line.length <= width, `a notice line is ${line.length} wide in a ${width} column`);
    }
  }
});

test("height 0 still yields nothing", () => {
  const b = new PaneBuffer();
  b.append(`${ESC}[1;1Hx`, { nowMs: NOW });
  assert.deepEqual(b.view({ height: 0, width: 40, nowMs: NOW }), []);
});

// ── R9: the two ways the protection was falsified ──────────────────────────────────────────────

test("A SPLIT ESCAPE IS STILL AN ESCAPE", () => {
  // A PTY splits its output wherever it likes. Review took the same bytes the detector caught whole
  // -- `ESC[12;40Hfragment` -- delivered them as `ESC[12;` then `40Hfragment`, and the executable
  // control reached the renderer; pyte confirmed it wrote at row 12 column 40 rather than the pane
  // origin. Detection now carries the unterminated escape across the boundary.
  const whole = new PaneBuffer();
  whole.append(`${ESC}[12;40Hfragment`);
  const split = new PaneBuffer();
  split.append(`${ESC}[12;`);
  split.append("40Hfragment");
  assert.equal(whole.isPainting(), true, "the whole escape stopped being detected");
  assert.equal(split.isPainting(), true, "the SAME bytes split across two chunks were not detected");
});

test("NEGATIVE CONTROL: an ordinary log is not a painted screen", () => {
  // Without this, a detector that answered true to everything would satisfy the test above and turn
  // every pane into a permanent notice.
  const plain = new PaneBuffer();
  plain.append("building...\ndone\n");
  assert.equal(plain.isPainting(), false);
  // ...and a lone ESC that never becomes a sequence must not latch the pane either.
  const stray = new PaneBuffer();
  stray.append(`${ESC}`);
  stray.append("plain text after a stray escape");
  assert.equal(stray.isPainting(), false, "an ESC that never completed latched the pane");
});

test("THE NOTICE DOES NOT EXPIRE INTO THE ESCAPE IT WAS HIDING", () => {
  // Review: the notice at N+30000, and at N+30001 the SAME buffered escape released to the renderer
  // with no new output at all. Silence is not evidence that cursor controls became safe log text --
  // the bytes did not change, only the clock did. `isPainting` is now a fact about the buffer.
  const pane = new PaneBuffer();
  pane.append(`${ESC}[12;40Hfragment`);
  assert.equal(pane.isPainting(), true);
  const later = pane.view({ width: 60, rows: 4 });
  assert.ok(later.join(" ").length > 0, "the pane rendered nothing at all");
  assert.ok(!later.join("").includes(`${ESC}[12;40H`),
    "the buffered cursor control was handed to the renderer");
});

test("R8: THE NOTICE NAMES THE COMMAND THAT WORKS, and promises nothing Enter does not do", () => {
  // It used to say "press Enter to attach". Review followed that instruction through the real
  // SSE -> follower -> buffer -> dashboard composition: Enter switches key forwarding ON but keeps
  // this notice-only renderer, so the title changes to "typing here" and input reaches the agent
  // while the operator sees no screen at all. Blind typing into a live worker is worse than a pane
  // that admits it cannot draw.
  const b = new PaneBuffer();
  b.append(`${ESC}[2J${ESC}[Hpainted`);
  const named = b.view({ height: 4, width: 60, agent: "sc-coder" }).join(" ");
  assert.match(named, /aify-env attach sc-coder/, "the notice does not name the exact command");
  assert.doesNotMatch(named, /press Enter/i,
    "the notice still promises that Enter restores the display, which it does not");

  // Without an agent it still names the command, with a placeholder rather than a wrong id.
  const anonymous = b.view({ height: 4, width: 60 }).join(" ");
  assert.match(anonymous, /aify-env attach <agent>/);
});
