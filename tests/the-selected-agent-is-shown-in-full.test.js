// The DETAIL pane shows the selected agent in full, under the table (0.9.9, the operator's TUI upgrade, item 4).
//
// The whole title, wrapped rather than clipped; role and cwd from its record; harness, model and effort from its
// definition; and how long it has been in its state. It starts collapsed to one heading line, which already names the
// agent and its state; `c` then `d` opens it (every-pane-collapses-and-expands.test.js).

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDashboard } from "../lib/tui.mjs";
import { layoutFrom, toggleCollapsed } from "../lib/tui-layout.mjs";
import { stateAge } from "../lib/tui-panes/agent-columns.mjs";

const NOW = 10_000_000;
const TITLE = "reviewing the definitions store split with every caller named and the one-writer gate held throughout";
const SNAPSHOT = {
  version: "0.9.9-dev", endpoint: "http://127.0.0.1:8802", nowMs: NOW, terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 2 }, traffic: {},
  processes: [{ id: "x-p1", pid: 1, label: "worker", service: "aify-comms", terminal: true, uptimeMs: 1, title: TITLE },
    { id: "x-p2", pid: 2, label: "quiet", service: "aify-comms", terminal: true, uptimeMs: 1, title: "" }],
  agentRecords: {
    worker: { agentId: "worker", state: "working", stateCause: "turn-open", role: "coder", launch: { cwd: "C:/w/app" },
      turn: { open: true, startedAtUs: (NOW - 12 * 60_000) * 1000 } },
  },
  definitions: { worker: { harness: "claude", model: "opus", effort: "high" } },
};
const KEYS = { enabled: true, canQuit: true };
const view = (selected = 0) => ({ rows: SNAPSHOT.processes, selected, mode: "dashboard", query: "", paneHidden: true });
const OPEN = layoutFrom(JSON.stringify({ expanded: ["detail"] }));
const detailOf = (lines) => {
  const at = lines.findIndex((line) => /DETAIL/.test(line));
  if (at < 0) return [];
  const end = lines.findIndex((line, i) => i > at && (line === "" || /^\S/.test(line)));
  return lines.slice(at, end < 0 ? undefined : end);
};

test("collapsed, as it starts, DETAIL is one heading line naming the agent and how long it has been in its state", () => {
  const detail = detailOf(renderDashboard(SNAPSHOT, { columns: 120, keys: KEYS, view: view() }));
  assert.equal(detail.length, 1, `collapsed DETAIL drew ${detail.length} lines`);
  assert.match(detail[0], /^▸ DETAIL worker · working for 12m \(turn-open\) ─+$/);
});

test("open, it shows the whole title wrapped, never clipped, and every field from the record and the definition", () => {
  const lines = renderDashboard(SNAPSHOT, { columns: 60, keys: KEYS, view: view(), layout: OPEN });
  const detail = detailOf(lines).join("\n");
  for (const word of TITLE.split(" ")) assert.ok(detail.includes(word), `the title lost "${word}"`);
  assert.ok(detailOf(lines).every((line) => line.length <= 60), "a DETAIL line ran past the terminal");
  for (const [label, value] of [["role", "coder"], ["cwd", "C:/w/app"], ["harness", "claude"], ["model", "opus"], ["effort", "high"],
    ["state", "working for 12m (turn-open)"]]) {
    assert.match(detail, new RegExp(`^  ${label}\\s+${value.replace(/[()]/g, "\\$&")}$`, "m"), `${label} is not ${value}`);
  }
});

test("a field nobody reported says so, and with no keyboard there is no selected agent, so no DETAIL", () => {
  const quiet = detailOf(renderDashboard(SNAPSHOT, { columns: 120, keys: KEYS, view: view(1), layout: OPEN })).join("\n");
  for (const label of ["title", "role", "cwd", "harness", "model", "effort", "state"]) {
    assert.match(quiet, new RegExp(`^  ${label}\\s+—$`, "m"), `an unreported ${label} was not said`);
  }
  // A VIEW IS HANDED IN, so it is the keyboard's absence that draws nothing, not a missing selection.
  const piped = renderDashboard(SNAPSHOT, { columns: 120, keys: { enabled: false, canQuit: false }, view: view(), layout: OPEN });
  assert.deepEqual(detailOf(piped), [], "a view with no keyboard drew a DETAIL");
});

test("toggleCollapsed: a pane that starts collapsed flips through `expanded`, any other through `collapsed`", () => {
  const old = layoutFrom(JSON.stringify({ collapsed: ["health"] }));
  assert.equal(old.collapsed.has("detail"), true, "a file that never mentions DETAIL must get it collapsed");
  const opened = toggleCollapsed(old, "detail");
  assert.deepEqual(opened.written, { collapsed: ["health"], expanded: ["detail"] });
  assert.equal(opened.layout.collapsed.has("detail"), false);
  const closed = toggleCollapsed(opened.layout, "detail");
  assert.deepEqual(closed.written, { collapsed: ["health"], expanded: [] });
  assert.equal(closed.layout.collapsed.has("detail"), true);
  const health = toggleCollapsed(old, "health");
  assert.deepEqual(health.written, { collapsed: [], expanded: [] }, "CONTROL: an ordinary pane flips through `collapsed`");
  assert.deepEqual(toggleCollapsed(health.layout, "health").written.collapsed, ["health"]);
  assert.equal(layoutFrom(JSON.stringify({ collapsed: ["detail"], expanded: ["detail"] })).collapsed.has("detail"), true,
    "named in `collapsed`, a pane is collapsed whatever `expanded` says");
});

test("stateAge: an open turn since it started, a closed one since its last event, nothing when the record does not say", () => {
  assert.equal(stateAge({ turn: { open: true, startedAtUs: (NOW - 5 * 60_000) * 1000, lastEventAtUs: NOW * 1000 } }, NOW), "5m");
  assert.equal(stateAge({ turn: { open: false, startedAtUs: 1, lastEventAtUs: (NOW - 2 * 60_000) * 1000 } }, NOW), "2m");
  assert.equal(stateAge({}, NOW), "");
});

test("the blank lines go before the heading, and the heading before any side section gives way", () => {
  // 0.9.10: the blank lines between sections say least, so they go first; DETAIL's ▸ heading at least says the pane is
  // there (the operator could not find it on 2026-10-29). Then the heading, still before any pane is drawn ▹.
  const options = { columns: 100, keys: KEYS, view: view() };
  const full = renderDashboard(SNAPSHOT, options);
  const gapless = renderDashboard(SNAPSHOT, { ...options, gapless: true });
  const without = renderDashboard(SNAPSHOT, { ...options, gapless: true, layout: layoutFrom(JSON.stringify({ hidden: ["detail"] })) });
  assert.ok(full.length > gapless.length, "CONTROL: this frame has blank lines to give");
  assert.equal(gapless.length, without.length + 1, "CONTROL: the collapsed heading is one line");
  const oneShort = renderDashboard(SNAPSHOT, { ...options, rows: full.length - 1 });
  assert.ok(oneShort.some((line) => line.startsWith("▸ DETAIL")), "one row short, the heading went before a blank line");
  assert.deepEqual(renderDashboard(SNAPSHOT, { ...options, rows: without.length }), without,
    "the blank lines gone and one row short, the view gave up a side section instead of the heading");
});

test("an OPENED detail does not give way: the operator asked for it, so it stays however tight the view", () => {
  const tight = renderDashboard(SNAPSHOT, { columns: 100, keys: KEYS, view: view(), layout: OPEN, rows: 20 });
  assert.ok(tight.some((line) => /DETAIL worker/.test(line)), "an opened DETAIL was dropped to fit");
});

test("DETAIL follows the agents when a `panes` order leaves it out, and stays where a file puts it", () => {
  assert.deepEqual(layoutFrom(JSON.stringify({ panes: ["traffic", "agents", "health"] })).order.slice(0, 4), ["traffic", "agents", "detail", "health"]);
  assert.deepEqual(layoutFrom(JSON.stringify({ panes: ["detail", "traffic", "agents"] })).order.slice(0, 3), ["detail", "traffic", "agents"]);
  assert.equal(layoutFrom(JSON.stringify({ panes: ["traffic"], hidden: [] })).order.indexOf("detail"),
    layoutFrom(JSON.stringify({ panes: ["traffic"] })).order.indexOf("agents") + 1, "CONTROL: after the agents when they too are left out");
});
