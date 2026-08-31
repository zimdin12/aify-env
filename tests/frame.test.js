// Turning one screen into the next by writing only what changed.
//
// THE PROPERTY THAT MATTERS IS WHICH ROWS WERE TOUCHED, and it is the one a screenshot could never
// show: a screen that flickers and a screen that repaints one row look identical once painted. So
// these assert the BYTES, which is also why `frameUpdate` takes and returns plain values instead of
// writing to a stream.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEAR_SCREEN,
  ERASE_BELOW,
  ERASE_LINE,
  changedRowCount,
  frameUpdate,
  moveToRow,
} from "../lib/frame.mjs";

const FRAME = ["one", "two", "three"];

test("the FIRST frame clears, because the screen's contents are unknown", () => {
  // There may be a shell prompt or half a log line up there. Treating an unknown screen as blank is
  // how a repaint leaves somebody's unfinished command sitting under the dashboard.
  const bytes = frameUpdate([], FRAME);
  assert.ok(bytes.startsWith(CLEAR_SCREEN), JSON.stringify(bytes.slice(0, 20)));
  for (const line of FRAME) assert.ok(bytes.includes(line), line);
});

test("AN UNCHANGED FRAME WRITES NOTHING AT ALL", () => {
  // The whole point. The old loop wrote a full clear and a full repaint twice a second whether or
  // not a single character differed, which is what a side pane cannot survive.
  assert.equal(frameUpdate(FRAME, FRAME), "");
  assert.equal(frameUpdate(FRAME, [...FRAME]), "", "equal content compared by identity");
});

test("one changed row touches ONLY that row", () => {
  const bytes = frameUpdate(FRAME, ["one", "CHANGED", "three"]);
  assert.ok(bytes.includes(`${moveToRow(2)}CHANGED`), JSON.stringify(bytes));
  // The rows that did not change are never addressed, which is what stops them blinking.
  assert.ok(!bytes.includes(moveToRow(1)), "an unchanged row was rewritten");
  assert.ok(!bytes.includes(moveToRow(3)), "an unchanged row was rewritten");
  assert.ok(!bytes.includes(CLEAR_SCREEN), "a steady-state frame cleared the screen");
});

test("the line is erased AFTER the text, so a changed row never blanks first", () => {
  const bytes = frameUpdate(FRAME, ["one", "CHANGED", "three"]);
  assert.ok(bytes.indexOf("CHANGED") < bytes.indexOf(ERASE_LINE, bytes.indexOf("CHANGED")),
            "the row was cleared before it was rewritten, which is a visible flash");
});

test("A SHORTER FRAME ERASES WHAT IS BELOW IT", () => {
  // The failure a naive "write the new lines" painter has: rows from the taller previous frame stay
  // on screen and read as current. One erase-below covers all of them.
  const bytes = frameUpdate(FRAME, ["one"]);
  assert.ok(bytes.includes(`${moveToRow(2)}${ERASE_BELOW}`), JSON.stringify(bytes));
});

test("a LONGER frame writes its new rows", () => {
  const bytes = frameUpdate(["one"], ["one", "two"]);
  assert.ok(bytes.includes(`${moveToRow(2)}two`), JSON.stringify(bytes));
  assert.ok(!bytes.includes(`${moveToRow(1)}`), "row 1 was identical and should not be touched");
});

test("the cursor is parked below the frame, not left mid-screen", () => {
  // Left where the last write ended, it sits on top of a character and reads as a rendering defect.
  for (const [before, after] of [[[], FRAME], [FRAME, ["one", "x", "three"]], [FRAME, ["one"]]]) {
    const bytes = frameUpdate(before, after);
    assert.ok(bytes.endsWith(moveToRow(after.length + 1)), JSON.stringify(bytes.slice(-12)));
  }
});

test("changedRowCount separates 'flickering' from 'repainting one row'", () => {
  // Those look the same in a screenshot and are opposite diagnoses.
  assert.equal(changedRowCount(FRAME, FRAME), 0);
  assert.equal(changedRowCount(FRAME, ["one", "CHANGED", "three"]), 1);
  assert.equal(changedRowCount(FRAME, ["a", "b", "c"]), 3);
  assert.equal(changedRowCount(FRAME, ["one"]), 2, "rows that vanished still changed");
  assert.equal(changedRowCount([], FRAME), 3);
});

test("nothing here is decorative: every escape emitted is one of the declared ones", () => {
  // ANTI-VACUITY for the assertions above. If the module started emitting some other sequence the
  // tests would still pass on `includes`, so the whole output is accounted for.
  const bytes = frameUpdate(FRAME, ["one", "CHANGED", "three"]);
  const stripped = bytes
    .split(ERASE_LINE).join("")
    .split(ERASE_BELOW).join("")
    .split(CLEAR_SCREEN).join("")
    .replace(/\[\d+;1H/g, "");
  assert.equal(stripped, "CHANGED", JSON.stringify(stripped));
});
