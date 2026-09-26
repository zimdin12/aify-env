// A screen taller than the pane is shown from its live edge, and the title says rows are hidden.
//
// THE DEFECT (v0.7 scan, F5). The emulated screen was sliced from the TOP. A PTY is 30 rows by
// default and a pane is the terminal's height minus two, so on an ordinary terminal the last rows
// were dropped -- the prompt, the status line, the input box -- and an attached pane said "typing
// here" while the line being typed into was off screen. The title reported a column crop and never
// a row crop.

import assert from "node:assert/strict";
import test from "node:test";

import { paintedRowCount, screenLines } from "../lib/screen-render.mjs";
import { paneTitle } from "../lib/console-view.mjs";

/** A 40-row agent screen: old transcript at the top, the prompt on the second-last row. */
function tallScreen() {
  const rows = Array.from({ length: 40 }, () => "");
  rows[1] = "old transcript line";
  rows[38] = "> type here";
  return rows;
}

test("a 20-row pane on a 40-row screen shows the prompt", () => {
  const lines = screenLines(tallScreen(), { width: 80, height: 20 });
  assert.ok(lines.includes("> type here"), `the input line was cropped away: ${JSON.stringify(lines)}`);
  assert.ok(lines.length <= 20);
});

test("CONTROL: a pane tall enough for the whole screen shows both ends", () => {
  const lines = screenLines(tallScreen(), { width: 80, height: 40 });
  assert.ok(lines.includes("old transcript line"));
  assert.ok(lines.includes("> type here"));
});

test("a short screen with blank rows below it is not pushed off the top", () => {
  // Content only at the top of a tall PTY: the crop is measured from the LAST painted row, so the
  // empty bottom does not cost the rows that carry something.
  const rows = ["header", "body", ...Array.from({ length: 38 }, () => "")];
  assert.deepEqual(screenLines(rows, { width: 80, height: 20 }), ["header", "body"]);
});

test("the painted rows of a screen run to its last non-blank row, whatever is blank above it", () => {
  // What the title's crop claim is counted from (v0.7.1 review, E4): 39, not the PTY's 40, and not 2.
  assert.equal(paintedRowCount(tallScreen()), 39);
  assert.equal(paintedRowCount(["", "  ", ""]), 0);
});

test("the title says when the producer has painted more rows than the pane", () => {
  const pane = { status: "streaming", label: "alpha", screenCols: 80, paintedRows: 40 };
  assert.match(paneTitle(pane, 80, 20), /20 rows above, cropped/);
  // CONTROL: silent when it fits, like the column note.
  assert.doesNotMatch(paneTitle({ ...pane, paintedRows: 20 }, 80, 20), /rows/);
  assert.doesNotMatch(paneTitle(pane, 80), /rows/, "a caller that gave no height is claimed nothing about");
});
