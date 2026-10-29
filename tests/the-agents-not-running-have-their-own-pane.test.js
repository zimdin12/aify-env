// The agents this environment defines and is not running have their own pane, ROSTER (0.9.7).
//
// THE OPERATOR'S ASK, 2026-10-28: stopped agents in their own collapsible pane; the agents table stays running-only.
// That day /agents/state named 27 agents and the table showed the 9 with a process.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDashboard } from "../lib/tui.mjs";
import { rosterLength } from "../lib/tui-panes/roster.mjs";
import { layoutFrom } from "../lib/tui-layout.mjs";

const NOW_MS = 1_000_000_000;
const record = (agentId, lifetime, state, stateCause, over = {}) => ({ agentId, lifetime, state, stateCause, ...over });
const SNAPSHOT = {
  version: "0.9.7-dev", endpoint: "e", nowMs: NOW_MS, terminals: { available: true }, services: [], checks: [],
  processes: [{ id: "x-p1", pid: 1, label: "runner", service: "aify-comms", terminal: true, uptimeMs: 60_000, title: "busy" }],
  agentRecords: {
    runner: record("runner", "life-1", "working", "turn-open"),
    resident: record("resident", "life-2", "idle", "at-prompt"),
    zulu: record("zulu", null, "stopped", "operator-stop"),
    alpha: record("alpha", null, "available", "startable"),
    mike: record("mike", null, "stopped", "operator-stop"),
    broken: record("broken", null, "unknown", "identity-unknown"),
  },
};
const KEYS = { enabled: true, canQuit: true };
const VIEW = { rows: SNAPSHOT.processes, selected: 0, mode: "dashboard", query: "", paneHidden: true };
const draw = (options = {}) => renderDashboard(SNAPSHOT, { columns: 120, color: false, ...options });
const rosterOf = (lines) => {
  const at = lines.findIndex((line) => /^▸? ?ROSTER/.test(line));
  if (at < 0) return [];
  const end = lines.findIndex((line, i) => i > at && line === "");
  return lines.slice(at, end < 0 ? undefined : end);
};

test("ROSTER lists the agents with no lifetime, by name, each with its status; the running and residents stay out", () => {
  const roster = rosterOf(draw());
  assert.match(roster[0], /^ROSTER 4 not running · 2 stopped · 1 available · 1 unknown/);
  const names = roster.slice(2).map((line) => line.trim().split(/\s+/)[0]);
  assert.deepEqual(names, ["alpha", "broken", "mike", "zulu"], "not the four with no lifetime, by name");
  assert.equal(rosterLength(SNAPSHOT), names.length, "the fitting pass narrows from a count that is not the pane's rows");
  assert.match(roster.find((line) => line.includes("zulu")), /○ stopped|● stopped/);
  assert.match(roster.find((line) => line.includes("broken")), /unknown identity-unknown/, "an unknown agent says why");
  assert.ok(!roster.some((line) => line.includes("operator-stop")), "a routine cause was drawn");
  for (const live of ["runner", "resident"]) assert.ok(!roster.some((line) => line.includes(live)), `${live} has a lifetime`);
});

test("the agents table stays running-only", () => {
  const lines = draw({ keys: KEYS, view: VIEW });
  const table = lines.slice(lines.findIndex((line) => line.startsWith("PROCESSES")), lines.findIndex((line) => line.startsWith("ROSTER")));
  assert.ok(table.some((line) => line.includes("runner")), "the control: the running agent is in the table");
  for (const quiet of ["zulu", "alpha", "mike", "broken"]) assert.ok(!table.some((line) => line.includes(quiet)), `${quiet} is in the table`);
});

test("collapsed with the pane menu it is its heading alone, ▸; squeezed, it shows what fits, then its heading alone, ▹", () => {
  const collapsed = draw({ layout: layoutFrom(JSON.stringify({ collapsed: ["roster"] })) });
  assert.deepEqual(rosterOf(collapsed), [collapsed.find((line) => line.startsWith("▸ ROSTER"))]);
  assert.match(rosterOf(collapsed)[0], /4 not running/);
  // SHOWS WHAT FITS (0.9.10). Before, the frame being four rows over put every side pane on one line at once, and on the
  // operator's 129x40 pane twenty stopped agents took HEALTH's FAIL rows with them (2026-10-29).
  const tall = draw({ keys: KEYS, view: VIEW });
  const NAMES = /^\s+(alpha|broken|mike|zulu)\s/;
  const MORE = /^\s+\+(\d+) more/;
  const at = (rows) => draw({ keys: KEYS, view: VIEW, rows });
  const heights = Array.from({ length: tall.length - 9 }, (_, i) => tall.length - i);
  const windowed = heights.filter((rows) => at(rows).some((line) => MORE.test(line)));
  assert.ok(windowed.length >= 2, "no height showed the roster windowed");
  const lowest = Math.min(...windowed);
  for (const rows of heights) {
    const frame = at(rows);
    assert.ok(frame.length <= rows, `${frame.length} lines on a ${rows}-row terminal`);
    assert.ok(frame.some((line) => line.includes("runner")), `a running agent lost its row to the roster at ${rows} rows`);
    const shown = frame.filter((line) => NAMES.test(line)).length;
    const more = Number(frame.map((line) => line.match(MORE)?.[1]).find(Boolean) ?? 0);
    if (rows >= lowest) {
      assert.ok(frame.some((line) => line.startsWith("ROSTER 4 not running")), `the roster gave way with room for a row, at ${rows}`);
      assert.equal(shown + more, 4, `at ${rows} rows the roster shows ${shown} and counts ${more} more, of 4`);
      assert.ok(shown >= 1);
    } else {
      assert.ok(frame.some((line) => line.startsWith("▹ ROSTER 4 not running")), `no room, and the roster is not its ▹ heading, at ${rows}`);
      assert.equal(shown, 0);
    }
  }
  assert.ok(heights.some((rows) => rows < lowest), "CONTROL: a height too short for one row was tried");
  assert.ok(heights.some((rows) => at(rows).filter((line) => NAMES.test(line)).length === 4 && rows < tall.length), "CONTROL: blank lines went before any name");
});

test("nothing defined and not running, no pane", () => {
  const lines = renderDashboard({ ...SNAPSHOT, agentRecords: { runner: SNAPSHOT.agentRecords.runner } }, { columns: 120, color: false });
  assert.ok(!lines.some((line) => line.includes("ROSTER")));
});
