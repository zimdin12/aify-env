// Each agent's row says for how long it has been in its state, and why when the state needs looking at (0.9.7).
//
// THE OPERATOR'S ASK, 2026-10-28: "clear view of the title ... + what agent is doing what (status) at a glance", and of
// the duration: "it can be just 12m, without this working part". The environment already said both: /agents/state
// carries each agent's turn and stateCause. Until 0.9.7 the view kept only the state word (statesById), so the row
// could show neither.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDashboard, width } from "../lib/tui.mjs";
import { layoutFrom } from "../lib/tui-layout.mjs";
import { stateSuffix } from "../lib/tui-panes/agent-columns.mjs";

const NOW_MS = 1_000_000_000;
const minutesAgoUs = (minutes) => (NOW_MS - minutes * 60_000) * 1000;
const EXTENDED = layoutFrom(JSON.stringify({ extended: true }));
const KEYS = { enabled: true, canQuit: true };

function rowFor(record, { columns = 140, layout = null, title = "busy", label = "worker" } = {}) {
  const proc = { id: "x-p1", pid: 1, label, service: "aify-comms", terminal: true, uptimeMs: 3_600_000, title };
  const snapshot = { version: "0.9.7-dev", endpoint: "e", nowMs: NOW_MS, terminals: { available: true }, services: [], checks: [],
    processes: [proc], agentRecords: record ? { [label]: { agentId: label, ...record } } : {} };
  const view = { rows: [proc], selected: 0, mode: "dashboard", query: "", paneHidden: true };
  return renderDashboard(snapshot, { columns, color: false, keys: KEYS, view, layout }).find((line) => line.includes(label)) ?? "";
}

test("a working agent's dot says how long its turn has run, with no word: \"● 12m\"", () => {
  const row = rowFor({ state: "working", stateCause: "turn-open", turn: { open: true, startedAtUs: minutesAgoUs(12) } });
  assert.match(row, /●\s12m\s+worker/, row);
  assert.doesNotMatch(row, /working|turn-open/, "the default row carries a word the operator asked to drop");
});

test("an idle agent's dot says how long since its last turn ended", () => {
  const row = rowFor({ state: "idle", stateCause: "at-prompt", turn: { open: false, startedAtUs: minutesAgoUs(9), lastEventAtUs: minutesAgoUs(3) } });
  assert.match(row, /●\s3m\s+worker/, row);
});

test("a blocked agent says why instead of how long; a routine cause says nothing", () => {
  const blocked = rowFor({ state: "blocked", stateCause: "folder-trust", turn: { open: true, startedAtUs: minutesAgoUs(12) } });
  assert.match(blocked, /●\sfolder-trust\s+worker/, blocked);
  assert.doesNotMatch(blocked, /12m/);
  for (const [state, stateCause] of [["working", "turn-open"], ["idle", "at-prompt"], ["shell", "at-prompt"], ["starting", "starting"]]) {
    const row = rowFor({ state, stateCause });
    assert.ok(!row.includes(stateCause), `${state}'s routine cause ${stateCause} was drawn: ${row}`);
  }
});

test("a state the palette does not know shows its cause too, under a plain dot", () => {
  const row = rowFor({ state: "unknown", stateCause: "identity-unknown" });
  assert.match(row, /○\sidentity-unknown\s+worker/, row);
});

test("nothing is invented: no turn, no clock or a clock behind the turn draws the dot alone", () => {
  assert.equal(stateSuffix({ state: "working", stateCause: "turn-open" }, NOW_MS), "");
  assert.equal(stateSuffix({ state: "working", turn: { open: true, startedAtUs: minutesAgoUs(5) } }, undefined), "");
  assert.equal(stateSuffix({ state: "working", turn: { open: true, startedAtUs: minutesAgoUs(-5) } }, NOW_MS), "");
  assert.equal(stateSuffix({ state: "blocked" }, NOW_MS), "", "a blocked record with no cause");
  assert.equal(stateSuffix(undefined, NOW_MS), "");
  assert.match(rowFor(null), /—\s+worker/, "an agent the environment did not report");
});

test("the extended set keeps the word, then the same suffix: \"● working 12m\"", () => {
  const row = rowFor({ state: "working", stateCause: "turn-open", turn: { open: true, startedAtUs: minutesAgoUs(12) } }, { columns: 200, layout: EXTENDED });
  assert.match(row, /● working 12m\s+worker/, row);
  const up = rowFor({ state: "working" }, { columns: 200, layout: EXTENDED });
  assert.match(up, /\s1h0m\s/, "`up` went missing from the extended set");
});

test("THE TITLE GETS THE ROOM: a 73-character title shows at least 59 of them at 100 columns", () => {
  // MEASURED BEFORE 0.9.7: 53 at 100 columns, 33 at 80. The dot's column was padded to the six of "status" and `up`
  // sat before the title. Whole at 140, which is the control. A 20-CHARACTER NAME, the longest on the live host on
  // 2026-10-28: with a short one the title had room whatever sat before it, and this test could not fail.
  const title = "reviewing the wrapper's HTTP entry and the sessions folder design, part 2";
  assert.equal(title.length, 73);
  const record = { state: "working", turn: { open: true, startedAtUs: minutesAgoUs(12) } };
  const shown = (columns) => {
    const row = rowFor(record, { columns, title, label: "comms-tech-lead-long" });
    assert.ok(width(row) <= columns, `the row is wider than ${columns}`);
    let n = 0;
    while (n < title.length && row.includes(title.slice(0, n + 1))) n += 1;
    return n;
  };
  assert.ok(shown(100) >= 59, `only ${shown(100)} of 73 at 100 columns`);
  assert.equal(shown(140), 73, "the control: a wide terminal shows the whole title");
});
