// At 100x24 the agents get the space, and the last outcome never leaves the screen (v0.7.7, TUI 2-3).
//
// THE DEFECT. SERVICES, HEALTH, RECENT EXITS and TRAFFIC always rendered in full, so on an ordinary
// 24-row terminal with 12 agents the table shrank to one row. And a start or stop result went only
// into NOTICES, which is the first section fitting trims, so the answer vanished at 24 rows.

import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboard } from "../lib/tui.mjs";

const NOW = 1_800_000_000_000;
const agents = (n) => Array.from({ length: n }, (_, i) => ({
  id: `0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0-p${i}`, pid: 1000 + i, label: `agent-${String(i).padStart(2, "0")}`,
  service: "aify-comms", terminal: true, uptimeMs: 60_000 * (i + 1), title: "claude", lastOutputAtMs: NOW - 500,
}));

/** A host shaped like the operator's on 2026-09-29: two services, ten checks with problems, exits, notices. */
const snapshot = (n) => ({
  version: "0.7.2", build: "43b50ea8", endpoint: "http://127.0.0.1:63204", nowMs: NOW,
  terminals: { available: true },
  services: [
    { name: "aify-comms", state: "passed", endpoint: "http://127.0.0.1:8800", detail: "0.7.6" },
    { name: "aify-graph", state: "unanswered", endpoint: "http://127.0.0.1:8900", detail: "ECONNREFUSED" },
  ],
  checks: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `check-${i}`, state: "passed", detail: "ok" })),
    { id: "code-current", state: "failed", detail: "the code on disk changed after this process started" },
    { id: "registry", state: "unknown", detail: "could not read" },
  ],
  processes: agents(n),
  history: {
    startedTotal: 20, lastExitAtMs: NOW - 60_000,
    recentExits: [1, 2, 3].map((i) => ({ id: `x${i}`, label: `gone-${i}`, atMs: NOW - i * 60_000, code: 1 })),
  },
  notices: [1, 2, 3, 4, 5].map((i) => ({ text: `output not delivered: fetch failed ${i}`, count: 1, atMs: NOW - i })),
  traffic: { requests: 1234, bytesOut: 56789 },
});

function frame(n, { rows = 24, outcome = "starting sc-manager…", selected = 0 } = {}) {
  return renderDashboard(snapshot(n), {
    columns: 100, rows, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: agents(n), selected, mode: "dashboard", query: "", paneHidden: true, outcome },
  });
}

test("at 100x24 with 12 agents, every agent row, the outcome and the hint are on screen", () => {
  const lines = frame(12);
  const text = lines.join("\n");
  assert.ok(lines.length <= 24, `${lines.length} lines on a 24-row screen`);
  for (let i = 0; i < 12; i += 1) {
    assert.match(text, new RegExp(`agent-${String(i).padStart(2, "0")}`), `agent ${i} is off screen:\n${text}`);
  }
  assert.match(text, /starting sc-manager…/, "the outcome line was dropped");
  assert.match(text, /s start/, "the hint line was dropped");
});

test("a collapsed HEALTH still says how many checks failed and how many are unknown", () => {
  const text = frame(12).join("\n");
  assert.match(text, /HEALTH.*8\/10 passing.*1 failed.*1 unknown/);
  assert.match(text, /SERVICES.*aify-graph/, "a service that does not answer is still named");
  assert.match(text, /RECENT EXITS.*3/);
  assert.match(text, /TRAFFIC.*1234/);
});

test("a frame with room is not collapsed", () => {
  // CONTROL: collapsing is how a frame is made to fit, not a new layout for every screen.
  const text = frame(12, { rows: 80 }).join("\n");
  assert.match(text, /code-current/, "HEALTH lost its failing rows on a screen with room for them");
  assert.match(text, /ENDPOINT/, "SERVICES lost its table on a screen with room for it");
});

test("the outcome line survives any amount of fitting", () => {
  for (const [n, rows] of [[30, 24], [60, 16], [5, 12]]) {
    const lines = frame(n, { rows, selected: n - 1 });
    assert.ok(lines.length <= rows, `${lines.length} lines for ${rows} rows`);
    assert.match(lines.join("\n"), /starting sc-manager…/, `dropped at ${n} agents on ${rows} rows`);
  }
});

test("no outcome, no line", () => {
  const text = frame(3, { rows: 80, outcome: "" }).join("\n");
  assert.doesNotMatch(text, /starting/);
});
