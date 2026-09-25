// An attached pane that is dropping keystrokes says so, instead of "typing here".
//
// THE DEFECT (v0.7 scan, F6). Input is correctly gated on a clean streaming frame. But when the
// frame drawn is a refusal notice -- waiting for a full repaint, concealed output, a TUI with no
// emulator, a failed stream -- the mode stays `pty`, and the title said "· typing here" and the hint
// "keys go to this agent" while every key was discarded. The operator types, nothing happens, and
// the text is gone.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { paneTitle } from "../lib/console-view.mjs";
import { renderDashboard } from "../lib/tui.mjs";

/** A session attached to `alpha`, whose follower reports `status` and `problem`. */
function attached({ status = "streaming", problem = "" } = {}) {
  const follower = {
    start() {}, stop() {}, status, exit: null, meta: { cols: 80, rows: 24 }, reason: "the daemon answered 503",
    paneProblem: () => problem, lines: () => [],
  };
  const s = new ConsoleSession({ makeFollower: () => follower });
  s.noteViewport({ columns: 160 });
  s.syncProcesses([{ id: "a", label: "alpha" }]);
  s.handleInput("\r");
  s.notePaneRendered(true);
  assert.equal(s.focus.mode, "pty", "the fixture did not attach");
  return s;
}

test("a pane showing a refusal notice says input is paused, and why", () => {
  const s = attached({ problem: "waiting for the first full repaint" });
  const title = paneTitle(s.pane(), 120);
  assert.doesNotMatch(title, /typing here/, `the title claims input is live: ${title}`);
  assert.match(title, /input paused: waiting for the first full repaint/);
  // And the keys really are dropped, which is what makes the title a lie without this fix.
  assert.equal(s.handleInput("x").toPty, null);
});

test("a pane whose stream is not live says input is paused", () => {
  const s = attached({ status: "failed" });
  assert.match(paneTitle(s.pane(), 120), /input paused: failed/);
});

test("CONTROL: a clean streaming pane still says typing here, and keys go through", () => {
  const s = attached();
  assert.match(paneTitle(s.pane(), 120), /typing here/);
  assert.equal(s.handleInput("x").toPty, "x");
});

test("the hint line agrees with the title", () => {
  const frame = (inputPaused) => renderDashboard({
    version: "0", endpoint: "e", terminals: { available: true }, services: [], checks: [],
    history: { startedTotal: 1 }, processes: [{ id: "a", label: "alpha" }],
  }, {
    columns: 160, keys: { enabled: true, canQuit: true },
    view: { rows: [{ id: "a", label: "alpha" }], selected: 0, mode: "pty", query: "", paneHidden: false, inputPaused },
  }).join("\n");
  assert.match(frame("waiting for the first full repaint"), /input paused/);
  assert.doesNotMatch(frame("waiting for the first full repaint"), /keys go to this agent/);
  assert.match(frame(""), /keys go to this agent/);
});
