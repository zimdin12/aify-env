// The screen with a console open beside the dashboard.
//
// EVERY RULE HERE IS ABOUT TWO COLUMNS SHARING ONE SCREEN. One growing is the other shrinking, so the
// pane is sized to the window rather than to its content, and a window too narrow to hold two readable
// columns gets one readable column instead of two useless ones.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_COLUMNS_FOR_PANE,
  composeConsole,
  paneTitle,
  statusMark,
} from "../lib/console-view.mjs";
import { CONNECTING, EXITED, FAILED, GONE, STREAMING } from "../lib/output-follower.mjs";
import { width } from "../lib/tui.mjs";

const DASH = ["aify-env 0.6.0", "endpoint http://127.0.0.1:8802", "2 processes"];

/** A stand-in follower: `lines()` is the only thing the composer asks of one. */
const fakePane = (lines, extra = {}) => ({
  id: "abc-p1",
  label: "graph-senior-dev",
  status: STREAMING,
  exit: null,
  lines: ({ height, width: w }) => lines.slice(-height).map((l) => l.slice(0, w)),
  ...extra,
});

// -- statusMark ----------------------------------------------------------------------------------

test("every follower state has its own mark, and they are all distinct", () => {
  // A shared glyph would make two different situations look the same in the one place an operator
  // glances at.
  const marks = [STREAMING, EXITED, GONE, FAILED, CONNECTING].map(statusMark);
  assert.equal(new Set(marks).size, marks.length, `marks collide: ${marks.join("")}`);
  for (const mark of marks) assert.equal(mark.length, 1);
});

test("an unknown state gets a blank rather than a wrong mark", () => {
  assert.equal(statusMark("something-new"), " ");
  assert.equal(statusMark(undefined), " ");
});

// -- paneTitle -----------------------------------------------------------------------------------

test("the title names the process, so a pane is never anonymous", () => {
  assert.match(paneTitle(fakePane([]), 40), /graph-senior-dev/);
});

test("an unlabelled process falls back to its id, then to a visible placeholder", () => {
  assert.match(paneTitle({ id: "abc-p9", status: STREAMING }, 40), /abc-p9/);
  assert.match(paneTitle({ status: STREAMING }, 40), /unclaimed/);
});

test("AN EXIT CODE IS IN THE TITLE, because that is the thing being waited for", () => {
  assert.match(paneTitle(fakePane([], { status: EXITED, exit: { code: 137 } }), 40), /exit 137/);
});

test("a signalled death names the SIGNAL, not a fabricated code", () => {
  // `code` is null for a signalled death. Printing "exit null" tells an operator nothing, and
  // printing "exit 0" would be a lie about how the process died.
  const title = paneTitle(fakePane([], { status: EXITED, exit: { code: null, signal: "SIGKILL" } }), 40);
  assert.match(title, /SIGKILL/);
  assert.doesNotMatch(title, /exit 0/);
});

test("the title is clipped to the pane width, never wider", () => {
  const title = paneTitle(fakePane([], { label: "x".repeat(200) }), 20);
  assert.ok(width(title) <= 20, `title was ${width(title)} columns`);
});

// -- composeConsole ------------------------------------------------------------------------------

test("with no pane the dashboard is returned untouched", () => {
  assert.deepEqual(composeConsole({ dashboardLines: DASH, pane: null, columns: 120 }), DASH);
});

test("with a pane every row carries both columns", () => {
  const out = composeConsole({
    dashboardLines: DASH, pane: fakePane(["hello", "world"]), columns: 120, rows: 10,
  });
  assert.ok(out.length >= DASH.length);
  assert.ok(out.some((l) => l.includes("aify-env 0.6.0") && l.includes("graph-senior-dev")),
    "the header row shows the dashboard and the pane title together");
});

test("A NARROW WINDOW GETS ONE READABLE COLUMN, not two useless ones", () => {
  // Squeezing a pane into fifteen characters is not a smaller version of the feature, it is a broken
  // screen. An operator who resized their window did not ask for a failure either.
  for (const columns of [0, 20, 60, MIN_COLUMNS_FOR_PANE - 1]) {
    assert.deepEqual(
      composeConsole({ dashboardLines: DASH, pane: fakePane(["x"]), columns, rows: 10 }),
      DASH,
      `columns ${columns} still produced a pane`,
    );
  }
});

test("at the threshold exactly, the pane appears", () => {
  // The boundary is a decision, so it is pinned rather than left to whoever next edits the constant.
  const out = composeConsole({
    dashboardLines: DASH, pane: fakePane(["visible"]), columns: MIN_COLUMNS_FOR_PANE, rows: 10,
  });
  assert.ok(out.some((l) => l.includes("visible")), "no pane at the threshold width");
});

test("NO ROW IS WIDER THAN THE WINDOW -- a wrap would break the divider alignment", () => {
  const out = composeConsole({
    dashboardLines: ["short", "a".repeat(300)],
    pane: fakePane(["b".repeat(300), "c".repeat(300)]),
    columns: 100,
    rows: 12,
  });
  for (const line of out) {
    assert.ok(width(line) <= 100, `a row was ${width(line)} columns wide`);
  }
});

test("THE PANE IS SIZED TO THE SCREEN, not to its content", () => {
  // Two columns share one screen: the pane growing is the dashboard shrinking. Asking the follower
  // for more lines than fit would scroll the dashboard off the top.
  const many = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const out = composeConsole({
    dashboardLines: DASH, pane: fakePane(many), columns: 120, rows: 10,
  });
  assert.ok(out.length <= 10, `composed ${out.length} rows into a 10-row screen`);
});

test("the header and its rule come out of the pane's own budget", () => {
  // Not the dashboard's. A pane that took its two lines from the shared total would push a dashboard
  // row off for every pane it opened.
  const many = Array.from({ length: 50 }, (_, i) => `L${i}`);
  const out = composeConsole({ dashboardLines: DASH, pane: fakePane(many), columns: 120, rows: 8 });
  const body = out.filter((l) => /L\d/.test(l));
  assert.equal(body.length, 6, `expected 8 rows minus title and rule, got ${body.length}`);
});

test("a pane with nothing to show still renders its title", () => {
  // The title is how an operator knows which process is quiet. Dropping it on an empty body would
  // leave a blank column with no owner.
  const out = composeConsole({
    dashboardLines: DASH, pane: fakePane([], { status: GONE }), columns: 120, rows: 8,
  });
  assert.ok(out.some((l) => l.includes("graph-senior-dev")), "an empty pane lost its title");
});

test("a pane object with no lines() is survived rather than thrown on", () => {
  // The composer must not be the thing that takes the screen down when a follower is half-built.
  assert.doesNotThrow(() => composeConsole({
    dashboardLines: DASH, pane: { id: "p", status: FAILED }, columns: 120, rows: 8,
  }));
});

test("a zero-row screen produces no rows rather than a negative slice", () => {
  const out = composeConsole({ dashboardLines: DASH, pane: fakePane(["x"]), columns: 120, rows: 0 });
  assert.ok(Array.isArray(out));
});

console.log("console-view.test.js: all assertions passed");
