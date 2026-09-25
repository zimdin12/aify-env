// The actions menu and its confirmation say what an action does, not only its name.
//
// THE DEFECT (v0.7 scan, F17). The menu rows were bare verbs (`attach`, `stop`) and the prompt was
// `stop <name>? y to confirm`. Nothing said that stop ends the whole process tree at once, mid-turn;
// the operator had to know what stop means in this tier.

import assert from "node:assert/strict";
import test from "node:test";

import { MENU_ACTIONS } from "../lib/keys.mjs";
import { ACTION_EFFECTS, renderDashboard } from "../lib/tui.mjs";

const rows = [{ id: "p1", label: "alpha" }];
const frame = (view) => renderDashboard({
  version: "0", endpoint: "e", terminals: { available: true }, services: [], checks: [],
  history: { startedTotal: 1 }, processes: rows,
}, {
  columns: 160, keys: { enabled: true, canQuit: true },
  view: { rows, selected: 0, query: "", paneHidden: true, menuActions: ["attach", "stop"], ...view },
}).join("\n");

test("every menu row carries a one-line description", () => {
  const text = frame({ mode: "menu", menuAt: 0 });
  assert.match(text, /attach\s+— your keys go into its terminal/);
  assert.match(text, /stop\s+— ends its process tree now/);
});

test("the stop confirmation states the consequence, under the question", () => {
  const text = frame({ mode: "confirm", confirming: "stop" });
  assert.match(text, /stop alpha\? y to confirm, any other key cancels\n\s+ends its process tree now — its current turn is lost/);
});

test("on a narrow terminal the explanation is what gets clipped, never how to refuse", () => {
  const narrow = renderDashboard({
    version: "0", endpoint: "e", terminals: { available: true }, services: [], checks: [],
    history: { startedTotal: 1 }, processes: rows,
  }, {
    columns: 60, keys: { enabled: true, canQuit: true },
    view: { rows, selected: 0, query: "", paneHidden: true, menuActions: ["attach", "stop"], mode: "confirm", confirming: "stop" },
  }).join("\n");
  assert.match(narrow, /y to confirm, any other key cancels/);
});

test("every action in the vocabulary has a description, so a new one cannot arrive bare", () => {
  for (const action of MENU_ACTIONS) {
    assert.ok(ACTION_EFFECTS[action], `${action} has no description`);
  }
});
