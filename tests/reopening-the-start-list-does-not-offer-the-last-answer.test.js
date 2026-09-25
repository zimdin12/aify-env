// Reopening the start list asks again, and does not offer the previous answer as current.
//
// THE DEFECT (v0.7 scan, F8). Opening the list reset only `startAsked`; the rows and their count
// survived. The renderer consults `asked` only when the list is empty, so the old rows were drawn with
// no "asking" marker, and Enter before the new answer landed started the stale row -- an agent that
// may have come up since, where a launch replaces any leftover instance of it on this host.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const DETACH = String.fromCharCode(29);

function reopened() {
  const s = new ConsoleSession({ makeFollower: () => ({ start() {}, stop() {}, lines: () => [] }) });
  s.syncProcesses([]);
  s.handleInput("s");
  s.noteStartable([{ id: "old-agent", name: "old-agent", status: "offline" }]);
  s.handleInput(DETACH);
  s.handleInput("s");
  return s;
}

test("the reopened list shows that it is asking, not the old rows", () => {
  const s = reopened();
  const frame = renderDashboard({
    version: "0", endpoint: "e", terminals: { available: true }, services: [], checks: [],
    history: { startedTotal: 0 }, processes: [],
  }, {
    columns: 120, keys: { enabled: true, canQuit: true },
    view: { rows: [], selected: -1, mode: s.focus.mode, query: "", start: s.startView() },
  }).join("\n");
  assert.doesNotMatch(frame, /old-agent/, "the previous answer was drawn as current");
  assert.match(frame, /asking/);
});

test("Enter before the new answer starts nothing", () => {
  const s = reopened();
  const chose = s.handleInput("\r");
  assert.equal(chose.startAgent, null, `Enter started ${JSON.stringify(chose.startAgent)} from a stale list`);
});

test("CONTROL: once the new answer lands, Enter starts from it", () => {
  const s = reopened();
  s.noteStartable([{ id: "fresh", name: "fresh" }]);
  assert.equal(s.handleInput("\r").startAgent?.id, "fresh");
});
