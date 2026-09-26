// The pane's title says rows are cropped only when painted rows were actually cut.
//
// THE DEFECT (v0.7.1 review, E4). The claim compared the PTY's HEIGHT with the pane's. But the pane
// keeps the last PAINTED rows, measured from the last row that carries anything -- so a 50-row PTY
// with 10 painted rows shows every one of them in a 20-row pane, and the title still said
// "50 rows, cropped". A title that claims text is missing sends the operator looking for it.
//
// Driven through the session and the compositor, so the height the title is judged against is the one
// `composeConsole` gives the body -- the call site the v0.7.1 review (E5) found no test watching.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { composeConsole } from "../lib/console-view.mjs";
import { STREAMING } from "../lib/output-follower.mjs";

/** A PTY of `height` rows with the first `painted` of them carrying text. */
function screenOf(height, painted) {
  return Array.from({ length: height }, (_, i) => (i < painted ? `row ${i + 1}` : ""));
}

/** The title line of a pane on a 160x`rows` terminal showing that screen. */
function titleFor(screenRows, rows) {
  const s = new ConsoleSession({
    makeFollower: (id) => ({
      id,
      status: STREAMING,
      meta: { cols: 40, rows: screenRows.length },
      screen: { rows: () => screenRows, unicodeVersion: "11" },
      start: async () => {},
      stop() {},
      paneProblem: () => "",
      lines: ({ height }) => screenRows.filter(Boolean).slice(-height),
    }),
  });
  s.noteViewport({ columns: 160 });
  s.syncProcesses([{ id: "p1", label: "alpha" }]);
  s.handleInput("p");
  const lines = composeConsole({ dashboardLines: [], pane: s.pane(), columns: 160, rows });
  return lines.find((line) => line.includes("alpha")) ?? "";
}

test("a tall PTY with few painted rows, all shown, claims no crop", () => {
  const title = titleFor(screenOf(50, 10), 22);
  assert.match(title, /alpha/, "positive control: no title was drawn");
  assert.doesNotMatch(title, /cropped/, `the title claims rows are missing: ${JSON.stringify(title)}`);
});

test("painted rows beyond the pane's body are claimed, with how many are out of view", () => {
  // 22 rows of terminal leave a 20-row body; 30 painted rows put 10 above it.
  const title = titleFor(screenOf(50, 30), 22);
  assert.match(title, /10 rows above, cropped/, `the crop went unsaid: ${JSON.stringify(title)}`);
});

test("exactly as many painted rows as the body holds is not a crop", () => {
  assert.doesNotMatch(titleFor(screenOf(50, 20), 22), /cropped/);
  assert.match(titleFor(screenOf(50, 21), 22), /1 rows above, cropped/);
});
