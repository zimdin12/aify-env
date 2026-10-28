// The aify-env pane shows each agent's status word, its dot in the dashboard's colour.
//
// THE OPERATOR, 2026-10-25: "for a long time i have seen in herdr-aify env's aify-env pane that statuses are just white
// dots, not yellow or cyan or blue or green or red". The only dot there was the activity mark (printed in the last
// three seconds), uncoloured by design. Since the 0.9.8 switch aify-env decides the status itself (`/agents/state`), so
// the pane draws that word, and the dot's hue comes from the same palette comms' parity test holds to the dashboard.

import assert from "node:assert/strict";
import test from "node:test";

import { agentRecordsById, collectSnapshot } from "../lib/dashboard.mjs";
import { dashboardWord, hueOf } from "../lib/agent-status-palette.mjs";
import { renderDashboard } from "../lib/tui.mjs";
import { layoutFrom } from "../lib/tui-layout.mjs";

const ESC = String.fromCharCode(27);
// Records as /agents/state gives them (0.9.7: the view keeps the record, not its word); only the word matters here.
const snapshot = (states) => ({
  version: "0.9.8", endpoint: "http://127.0.0.1:8802", terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 3 },
  processes: [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }, { id: "p3", label: "charlie" }],
  agentRecords: Object.fromEntries(Object.entries(states).map(([agentId, state]) => [agentId, { agentId, state }])),
});
const rowOf = (lines, label) => lines.find((line) => line.includes(label)) ?? "";

// THE DEFAULT VIEW DRAWS THE DOT ALONE, the extended one the dot and its word (0.9.6, the operator's ask to drop the
// status text by default). Both are held here: the hue is what the 2026-10-25 report was about, in either set.
const EXTENDED = layoutFrom(JSON.stringify({ extended: true }));

test("each row's dot is painted in its status's hue, and the extended view adds the word", () => {
  const states = { alpha: "working", bravo: "idle", charlie: "blocked" };
  const plain = renderDashboard(snapshot(states), { columns: 140, color: true });
  assert.match(rowOf(plain, "alpha"), new RegExp(`${ESC}\\[33m●${ESC}\\[0m\\s`), "working is yellow");
  assert.match(rowOf(plain, "bravo"), new RegExp(`${ESC}\\[32m●${ESC}\\[0m\\s`), "aify-env's idle is the dashboard's green");
  assert.match(rowOf(plain, "charlie"), new RegExp(`${ESC}\\[31m●${ESC}\\[0m\\s`), "blocked is red");
  assert.doesNotMatch(rowOf(plain, "alpha"), /working/, "the default view still draws the status word");
  const lines = renderDashboard(snapshot(states), { columns: 140, color: true, layout: EXTENDED });
  assert.match(rowOf(lines, "alpha"), new RegExp(`${ESC}\\[33m●${ESC}\\[0m working`), "working is yellow");
  assert.match(rowOf(lines, "bravo"), new RegExp(`${ESC}\\[32m●${ESC}\\[0m online`), "aify-env's idle reads as the dashboard's green online");
  assert.match(rowOf(lines, "charlie"), new RegExp(`${ESC}\\[31m●${ESC}\\[0m blocked`), "blocked is red");
});

test("a row with no word draws a dash, never a guessed status", () => {
  const plain = renderDashboard(snapshot({ alpha: "working" }), { columns: 140, color: false });
  assert.match(rowOf(plain, "bravo"), /^\s*—\s/, "bravo has no state, so its status cell is a dash");
  const lines = renderDashboard(snapshot({ alpha: "working" }), { columns: 140, color: false, layout: EXTENDED });
  assert.match(rowOf(lines, "bravo"), /^\s*—\s/, "bravo has no state, so its status cell is a dash");
  assert.match(rowOf(lines, "alpha"), /● working/, "control: alpha still draws its word");
  const unknown = renderDashboard(snapshot({ alpha: "unknown" }), { columns: 140, color: false, layout: EXTENDED });
  assert.match(rowOf(unknown, "alpha"), /○ unknown/, "a word with no hue is drawn plainly, hollow");
});

test("the palette speaks the dashboard's words, and an unknown word gets no hue", () => {
  assert.equal(dashboardWord("idle"), "online");
  assert.equal(dashboardWord(" Working "), "working");
  assert.equal(hueOf("idle"), "green");
  assert.equal(hueOf("shell"), "cyan");
  assert.equal(hueOf("available"), "blue");
  assert.equal(hueOf("unknown"), "");
});

test("agentRecordsById keeps well-formed rows of an answered /agents/state whole, and nothing from any other answer", () => {
  const a = { agentId: "a", state: "idle", stateCause: "at-prompt", turn: { open: false, lastEventAtUs: 5 } };
  const answered = { ok: true, body: { agents: [a, { agentId: 7, state: "x" }, { agentId: "b" }] } };
  assert.deepEqual(agentRecordsById(answered), { a });
  assert.deepEqual(agentRecordsById({ ok: false, error: "timed out" }), {});
  assert.deepEqual(agentRecordsById({ ok: true, body: { error: "nope" } }), {});
});

test("the snapshot asks the environment for its agents' states and keys them by id", async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const body = String(url).endsWith("/agents/state")
      ? { agents: [{ agentId: "alpha", state: "working", stateCause: "turn-open", turn: { open: true, startedAtUs: 1 } }], complete: true }
      : { ok: true, version: "0.9.8", processes: [{ id: "p1", label: "alpha" }] };
    return { ok: true, status: 200, json: async () => body };
  };
  const shot = await collectSnapshot({ endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
    fetchImpl, readFile: () => "", readCredentialStore: async () => ({ names: [] }), readInvocationRegistries: () => [] });
  assert.ok(asked.includes("http://127.0.0.2:1/agents/state"), asked.join(", "));
  assert.deepEqual(shot.agentRecords, { alpha: { agentId: "alpha", state: "working", stateCause: "turn-open", turn: { open: true, startedAtUs: 1 } } });
});
