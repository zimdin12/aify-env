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

import { PaneBuffer, CURSOR_PAINT_WINDOW_MS } from "../lib/pane-buffer.mjs";
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

test("IT IS A WINDOW, NOT A LATCH", () => {
  // A process that paints a banner at startup and then logs is a log again afterwards. Latching
  // would cost it a pane it could legitimately have, for the life of the process.
  const b = new PaneBuffer();
  b.append(`${ESC}[2J${ESC}[Hbanner`, { nowMs: NOW });
  assert.match(seen(b, NOW), /cannot draw/);
  b.append("\nnow just logging\nmore logs\n");
  assert.match(
    seen(b, NOW + CURSOR_PAINT_WINDOW_MS + 1000), /now just logging/,
    "a process that stopped painting never got its pane back",
  );
});

test("the window holds while a quiet TUI sits idle", () => {
  // An idle TUI repaints only when something changes. A window shorter than that would flicker
  // between the notice and a scrambled screen, which is worse than either.
  const b = new PaneBuffer();
  b.append(`${ESC}[5;1Hpainted`, { nowMs: NOW });
  assert.match(seen(b, NOW + CURSOR_PAINT_WINDOW_MS - 1), /cannot draw/);
});

test("a clock that runs backwards does not latch the pane", () => {
  // A stamp from the future is not evidence. Latching is the costly direction: it would hide a
  // working log behind a notice until the skew cleared.
  const b = new PaneBuffer();
  b.append(`${ESC}[5;1Hpainted`, { nowMs: NOW });
  b.cursorAddressedAtMs = NOW + 60_000;
  assert.equal(b.isPainting(NOW), false);
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
