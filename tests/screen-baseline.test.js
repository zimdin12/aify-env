#!/usr/bin/env node
// When a reconstructed screen may be shown as the truth.
//
// THE RULE THIS ENFORCES is the one review insisted on: a truncated replay cannot reconstruct a
// positioned screen, so a console built from one must SAY it is incomplete rather than draw something
// authoritative-looking. The part that makes it usable rather than a permanent refusal is that a full
// repaint also counts -- once a process throws its screen away and draws it again, whatever fell off
// the front stops bearing on what is displayed.
//
// PURE, so every rule is a function call. No emulator, no socket, no daemon.

import assert from "node:assert/strict";
import test from "node:test";

import { FULL_REPAINTS, baselineIsSound, baselineProblem, hasFullRepaint } from "../lib/screen-baseline.mjs";

const ESC = String.fromCharCode(27);

test("POSITIVE CONTROL: every sequence this module claims is a repaint is detected", () => {
  // The list and the detector are two things that could disagree. If one grew and the other did not,
  // a baseline would be waited for forever with the evidence already on screen.
  assert.ok(FULL_REPAINTS.length >= 1, "the repaint list has been emptied");
  for (const sequence of FULL_REPAINTS) {
    assert.equal(hasFullRepaint(`before${sequence}after`), true, `${JSON.stringify(sequence)} was missed`);
  }
});

test("ONLY RIS COUNTS, and the three sequences that used to are each a measured defect", () => {
  // I accepted four and review disproved three by feeding the WHOLE history to one emulator and the
  // retained SUFFIX to another. `screen-emulator.test.js` reproduces those comparisons against the
  // real package; this pins the RULE that came out of them, so a future edit cannot widen the list
  // back without meeting them.
  //
  //   ESC[2J     erases the display and resets NOTHING else -- with a conceal lost off the front the
  //              reconstruction PRINTED text the oracle hid. Disclosure, not a rendering difference.
  //   ESC[3J     clears scrollback, not the display.
  //   ESC[?1049h the alternate screen starts blank, but the normal screen underneath was never
  //              reconstructed and ESC[?1049l restores it.
  assert.deepEqual([...FULL_REPAINTS], [`${ESC}c`]);
  for (const notARepaint of [`${ESC}[2J`, `${ESC}[3J`, `${ESC}[?1049h`, `${ESC}[?1049l`]) {
    assert.equal(hasFullRepaint(notARepaint), false,
      `${JSON.stringify(notARepaint)} is treated as a full reset again -- it is not one`);
  }
});

test("MALFORMED METADATA FAILS CLOSED, because absent evidence is not evidence of completeness", () => {
  // The parser coerces a missing or non-boolean `truncated` to `false`, and `false` means "the
  // history is complete" -- the most dangerous of the three possible answers. A frame that does not
  // say must not be read as one that says yes.
  assert.equal(baselineIsSound({}, false), false, "a meta frame with no `truncated` read as complete");
  assert.equal(baselineIsSound({ truncated: undefined }, false), false);
  assert.equal(baselineIsSound({ cols: 80, rows: 24 }, false), false);
  assert.equal(baselineIsSound({ truncated: "no" }, false), false, "a string read as a claim");
  // POSITIVE CONTROL: a frame that DOES say complete is still believed.
  assert.equal(baselineIsSound({ truncated: false }, false), true);
});

test("NEGATIVE CONTROL: ordinary output is not a repaint", () => {
  // Without this, a detector returning true for everything would satisfy the test above and declare
  // every screen sound immediately -- which is the defect, not the fix.
  assert.equal(hasFullRepaint("plain text"), false);
  assert.equal(hasFullRepaint(""), false);
  assert.equal(hasFullRepaint(null), false);
  assert.equal(hasFullRepaint(`${ESC}[32mcoloured${ESC}[0m`), false, "colour is not a repaint");
});

test("A CURSOR MOVE IS NOT A REPAINT, and this is the rule that would quietly break the module", () => {
  // `ESC[H` homes the cursor and erases NOTHING. `ESC[J` erases from the cursor DOWN, leaving
  // everything above it exactly as it was. `ESC[1J` erases UP, leaving everything below. None of them
  // discards the lost history, so counting any of them would declare a screen trustworthy on the
  // strength of a cursor move -- reintroducing the defect while looking like a generosity.
  assert.equal(hasFullRepaint(`${ESC}[H`), false, "cursor home was counted as a repaint");
  assert.equal(hasFullRepaint(`${ESC}[J`), false, "erase-to-end was counted as a repaint");
  assert.equal(hasFullRepaint(`${ESC}[1J`), false, "erase-to-start was counted as a repaint");
  assert.equal(hasFullRepaint(`${ESC}[K`), false, "erase-in-LINE was counted as a whole-screen repaint");
});

test("A COMPLETE HISTORY IS SOUND FROM THE FIRST BYTE", () => {
  // Nothing was lost, so replaying it reproduces exactly what the process painted. A young process is
  // in this state and must not be made to wait for a repaint it has no reason to perform.
  assert.equal(baselineIsSound({ truncated: false }, false), true);
  assert.equal(baselineProblem({ truncated: false }, false), "");
});

test("A TRUNCATED HISTORY IS NOT SOUND UNTIL SOMETHING REPAINTS", () => {
  // The whole point. The bytes that fell off the front carried cursor moves and SGR state the
  // survivors cannot reconstruct, so a screen built from them is coherent-looking and possibly wrong.
  assert.equal(baselineIsSound({ truncated: true }, false), false);
  assert.match(baselineProblem({ truncated: true }, false), /incomplete/);

  // ...and then it is, because the process threw the screen away and drew it again.
  assert.equal(baselineIsSound({ truncated: true }, true), true);
  assert.equal(baselineProblem({ truncated: true }, true), "");
});

test("NO META IS NOT SOUND, because no evidence must not read as fine", () => {
  // A daemon too old to send a `meta` frame says nothing about whether its replay was complete.
  // Treating silence as "complete" is the false green this codebase keeps finding: the console would
  // present a possibly-wrong screen precisely where it knows least. It still becomes sound on the
  // first repaint, like any other stream, so an older daemon is degraded rather than refused.
  assert.equal(baselineIsSound(null, false), false);
  assert.match(baselineProblem(null, false), /does not report its history/);
  assert.equal(baselineIsSound(null, true), true);
  assert.equal(baselineProblem(null, true), "");
});

test("the reason is written for an operator, not for a protocol reader", () => {
  // A pane that cannot draw yet must say something a person can act on. "Waiting for a repaint" says
  // the console is coming; a sentence about a ring buffer answers a question nobody asked. And it
  // must never be empty while the screen is unsound, because a blank pane and a pane that cannot
  // speak look identical.
  for (const meta of [null, { truncated: true }]) {
    const said = baselineProblem(meta, false);
    assert.ok(said.length > 0, "an unsound screen said nothing at all");
    assert.match(said, /waiting/i, `not phrased as a wait: ${said}`);
  }
});

console.log("screen-baseline.test.js: all assertions passed");
