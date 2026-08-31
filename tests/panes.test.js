// The side-by-side layout: the geometry half of the operator's right-hand terminal pane.
//
// PURE, SO IT IS TESTED WITHOUT A SCREEN. Two arrays of lines in, one array out. No process, no
// keypress, no terminal — which is the whole reason the layout was split from the loop.
//
// THE COLOURED CASES ARE THE POINT. A padding function that counts escape bytes puts the divider in
// a different column on exactly the rows that carry state, and colour here is meaning-bearing by
// policy. A layout that is right in a piped test and wrong on a real screen would be worse than none.

import assert from "node:assert/strict";
import test from "node:test";

import { DIVIDER, clipToWidth, rightPaneWidth, sideBySide } from "../lib/panes.mjs";
import { width } from "../lib/tui.mjs";

const ESC = String.fromCharCode(27);
const red = (s) => `${ESC}[31m${s}${ESC}[0m`;

// ── rightPaneWidth ──────────────────────────────────────────────────────────────────────────────

test("the right pane gets what is left after the left column, two gaps and the divider", () => {
  // 80 - 40 - 1 - 1 - 1 = 37
  assert.equal(rightPaneWidth(80, 40), 37);
});

test("a terminal too narrow to split yields zero, not a negative width", () => {
  // A negative would become a huge slice or an empty string depending on who consumed it; zero is the
  // answer both callers already handle.
  assert.equal(rightPaneWidth(30, 40), 0);
  assert.equal(rightPaneWidth(0, 0), 0);
});

// ── sideBySide ──────────────────────────────────────────────────────────────────────────────────

test("NO right pane is a byte-for-byte no-op", () => {
  // The dashboard with no pane open must render exactly as it did before this module existed.
  // Composing against an empty column would pad every line to a fixed width and change a screen
  // nobody asked to change.
  const left = ["one", "two   ", ""];
  assert.deepEqual(sideBySide(left, [], { columns: 80 }), left);
  assert.deepEqual(sideBySide(left, null, { columns: 80 }), left);
});

test("a terminal too narrow to split falls back to the dashboard alone", () => {
  const left = ["dashboard"];
  assert.deepEqual(sideBySide(left, ["output"], { columns: 10, leftWidth: 40 }), left);
});

/**
 * The VISIBLE column the divider sits in.
 *
 * `indexOf` is the wrong instrument and getting that wrong is instructive: a coloured line carries
 * escape bytes before the divider, so its character index is larger while the column a reader sees is
 * identical. The first version of the coloured test below asserted on `indexOf` and failed against a
 * layout that was correct -- the same escape-blindness the module itself exists to prevent, committed
 * in the test that checks for it.
 */
const dividerColumn = (line) => width(line.slice(0, line.indexOf(DIVIDER)));

test("the divider lands in the same column on every row", () => {
  const out = sideBySide(["a", "bbbb", "cc"], ["x", "y", "z"], { columns: 40, leftWidth: 10 });
  assert.deepEqual(out.map(dividerColumn), [11, 11, 11], "the divider moved between rows");
});

test("A COLOURED LEFT LINE DOES NOT MOVE THE DIVIDER", () => {
  // The failure this module exists to prevent, and the one a naive `.length` produces: escapes are
  // bytes with no width, so counting them pushes the divider right on coloured rows only.
  const out = sideBySide(["plain", red("plain")], ["x", "y"], { columns: 40, leftWidth: 10 });
  assert.equal(dividerColumn(out[0]), dividerColumn(out[1]),
               "a coloured row put the divider in a different column");
  // ANTI-VACUITY: the two lines must genuinely differ in BYTES, or this proves nothing.
  assert.notEqual(out[0].indexOf(DIVIDER), out[1].indexOf(DIVIDER),
                  "the coloured row carried no escapes, so this test compared two identical strings");
});

test("the taller side decides the height; neither side is truncated to the other", () => {
  // A dashboard of nine rows beside a process of forty must not hide thirty-one of them.
  const out = sideBySide(["a"], ["1", "2", "3"], { columns: 40, leftWidth: 10 });
  assert.equal(out.length, 3);
  assert.match(out[2], /3$/, "the right pane lost its tail");
  const out2 = sideBySide(["a", "b", "c"], ["1"], { columns: 40, leftWidth: 10 });
  assert.equal(out2.length, 3, "the left column lost its tail");
});

test("a left line wider than its column is CLIPPED, never allowed to push the divider", () => {
  const out = sideBySide(["a-very-long-dashboard-line-indeed"], ["x"], { columns: 40, leftWidth: 10 });
  assert.equal(out[0].indexOf(DIVIDER), 11);
});

test("with no leftWidth given it measures the widest left line", () => {
  const out = sideBySide(["ab", "abcd"], ["x"], { columns: 40 });
  assert.equal(out[0].indexOf(DIVIDER), 5, "the column was not sized to the widest line");
});

test("trailing whitespace is trimmed, because the differential writer pays for every byte", () => {
  const out = sideBySide(["a"], [""], { columns: 40, leftWidth: 10 });
  assert.doesNotMatch(out[0], /\s$/);
});

test("junk lines are rendered as empty rather than the string 'undefined'", () => {
  const out = sideBySide([null, undefined], ["x", "y"], { columns: 40, leftWidth: 6 });
  assert.ok(!out.join("\n").includes("undefined"));
});

// ── clipToWidth ─────────────────────────────────────────────────────────────────────────────────

test("it counts printable characters, not bytes", () => {
  assert.equal(clipToWidth("abcdef", 3), "abc");
  assert.equal(clipToWidth("abc", 10), "abc");
  assert.equal(clipToWidth("abc", 0), "");
});

test("AN ESCAPE IS NEVER CUT IN HALF", () => {
  // Half an SGR sequence colours nothing, prints as garbage, and leaves the terminal in whatever
  // state the truncation left it -- bleeding colour into every line below the pane.
  const cut = clipToWidth(red("abcdef"), 3);
  assert.ok(cut.includes(`${ESC}[31m`), "the opening escape was damaged");
  assert.equal(cut.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), ""), "abc");
});

test("a clipped coloured line is RESET, so the colour does not tint the divider", () => {
  const cut = clipToWidth(red("abcdef"), 3);
  assert.ok(cut.endsWith(`${ESC}[0m`), "a cut line was left mid-colour");
});

test("escapes cost no width, so a fully-coloured short line survives whole", () => {
  // Anti-vacuity for the counting rule: if escapes were counted, this line would be clipped despite
  // showing only six characters.
  const line = red("abcdef");
  assert.equal(clipToWidth(line, 6), line);
});

test("a COLOURED left line keeps all its visible characters, not just its first bytes", () => {
  // FOUND BY MUTATION. Replacing the escape-aware clip with a naive `slice(0, width)` passed every
  // other test in this file: `pad()` still measures correctly, so the DIVIDER stays in its column and
  // the layout looks sound. What a byte-slice destroys is the CONTENT -- the escape sequence eats the
  // character budget, so a ten-character coloured line arrives showing five. The divider assertions
  // could not see that, because they only ever looked at where the boundary sits.
  const visible = "abcdefghij";           // exactly the column width
  const out = sideBySide([red(visible)], ["x"], { columns: 40, leftWidth: 10 });
  const plain = out[0].replace(new RegExp(`${ESC}\[[0-9;]*m`, "g"), "");
  assert.match(plain, /^abcdefghij/, "the coloured left line lost visible characters to its escapes");
});
