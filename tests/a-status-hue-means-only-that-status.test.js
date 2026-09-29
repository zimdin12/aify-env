#!/usr/bin/env node
// A status colour in the terminal is the dashboard's colour for that status, and means nothing else.
//
// THE OPERATOR, 2026-09-28: "are all statuses in sync, like same colors everywhere? otherwise it is
// confusing". Two collisions were on screen: the selected row was cyan, which is the dashboard's
// `shell`, and an agent printing output got a green dot, which is the dashboard's `online` while its
// `working` is amber. Whether each hue is the dashboard's own is held on the aify-comms side, which
// reads its stylesheet (service/new_dashboard/status-colours-match-aify-env.test.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_STATUS_HUES, hueOf } from "../lib/agent-status-palette.mjs";
import { startableAgents } from "../lib/startable-agents.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const ESC = String.fromCharCode(27);
const SGR = { yellow: "33", cyan: "36", green: "32", blue: "34", red: "31", grey: "90" };
const painted = (hue, text) => `${ESC}[${SGR[hue]}m${text}`;
const NOW = 1_790_000_000_000;
const SNAPSHOT = {
  version: "0.7.1", build: "abc", endpoint: "http://127.0.0.1:8802", nowMs: NOW,
  processes: [{ id: "p-1", pid: 42, label: "comms-senior-dev", lastOutputAtMs: NOW - 500, terminal: true }],
  services: [], checks: [], history: { startedTotal: 1 }, terminals: { available: true },
};
const render = (view) => renderDashboard(SNAPSHOT, {
  columns: 120, color: true, keys: { enabled: true, canQuit: true },
  view: { rows: SNAPSHOT.processes, selected: 0, query: "", ...view },
}).join("\n");
const START = {
  agents: startableAgents({ agents: {
    alpha: { status: "available", sessionMode: "managed", machineId: "here" },
    bravo: { status: "stopped", sessionMode: "managed", machineId: "here" },
  } }, { machineId: "here" }),
  at: 0, problem: "", asked: true,
};

test("CONTROL: the fixture offers both agents, so the menu below has rows to paint", () => {
  assert.deepEqual(START.agents.map((a) => [a.id, a.hue]), [["alpha", "blue"], ["bravo", "grey"]]);
});

test("the start menu shows each agent's status dot in the dashboard's colour for it", () => {
  const text = render({ mode: "start", start: START });
  assert.ok(text.includes(painted("blue", "●")), "available is not painted blue");
  assert.ok(text.includes(painted("grey", "●")), "stopped is not painted grey");
});

test("an agent printing output gets no status colour: printing is not working", () => {
  // THE OPERATOR, 2026-09-29: "i see working status (yellow dot) in aify-env for all agents". An
  // idle hermes redraws its status-bar clock every second, so amber here claimed a status nobody
  // measured. The mark says output, and wears no status's colour.
  const row = render({ mode: "dashboard" }).split("\n").find((line) => line.includes("comms-senior-dev"));
  assert.ok(row, "CONTROL: the process row is drawn");
  assert.ok(row.includes("●"), "CONTROL: the recent-output mark is drawn");
  for (const hue of new Set(Object.values(AGENT_STATUS_HUES))) {
    assert.ok(!row.includes(painted(hue, "●")), `the recent-output mark is painted ${hue}, a status colour`);
  }
});

test("no status hue is spent on selection, ids or the title", () => {
  // `shell` is the one status these screens never show, so cyan anywhere on them is chrome posing as it.
  for (const view of [{ mode: "dashboard" }, { mode: "start", start: START }, { mode: "menu", menuAt: 0 }, { mode: "find", query: "c" }]) {
    assert.ok(!render(view).includes(`${ESC}[${SGR[hueOf("shell")]}`), `${view.mode} paints something in shell's colour`);
  }
});

test("every hue in the table is one the terminal can paint", () => {
  for (const [status, hue] of Object.entries(AGENT_STATUS_HUES)) assert.ok(SGR[hue], `${status} -> ${hue}`);
  assert.equal(hueOf("no-such-status"), "", "an unknown status is guessed a colour");
});
