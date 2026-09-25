// Ctrl+C backs out of a mode, and in the daemon's own terminal it asks before stopping everything.
//
// THE DEFECT (v0.7 scan, F1). In the daemon's view one Ctrl+C from the dashboard, the menu, the start
// list or the picker went straight to `shutdown("keyboard")`, which ends every managed worker on the
// host. The menu, the start list and the picker are exactly where an operator reaches for Ctrl+C to
// BACK OUT, and nothing on screen said what it did there.
//
// THE DECISION this pins: in `menu`, `start` and `picker` Ctrl+C closes that mode, the way `confirm`
// already treats it as cancel. In dashboard mode on the daemon's own view it asks "stop the
// environment and its N workers?", and only a single `y` confirms. A signal-delivered SIGINT is not a
// keystroke and is not routed through here, so it keeps its meaning.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { routeKey } from "../lib/keys.mjs";
import { ConsoleSession } from "../lib/console-session.mjs";
import { renderDashboard } from "../lib/tui.mjs";
import { startDashboard } from "../lib/dashboard.mjs";
import { startDaemonView } from "../lib/daemon-view.mjs";

const CTRL_C = String.fromCharCode(3);
const dash = (extra = {}) => ({ mode: "dashboard", selected: 0, count: 3, query: "", ...extra });

// ── the router ──────────────────────────────────────────────────────────────────────────────────

test("Ctrl+C in the MENU closes the menu", () => {
  const out = routeKey(CTRL_C, dash({ mode: "menu", menuAt: 1 }));
  assert.equal(out.action, "menu-close");
  assert.equal(out.state.mode, "dashboard");
});

test("Ctrl+C in the START list closes the list", () => {
  const out = routeKey(CTRL_C, dash({ mode: "start", startAt: 2, startCount: 4 }));
  assert.equal(out.action, "start-close");
  assert.equal(out.state.mode, "dashboard");
});

test("Ctrl+C in the PICKER cancels the search", () => {
  const out = routeKey(CTRL_C, dash({ mode: "picker", query: "sc" }));
  assert.equal(out.action, "picker-close");
  assert.equal(out.state.mode, "dashboard");
  assert.equal(out.state.query, "");
});

test("in a view that CONFIRMS its interrupt, Ctrl+C on the dashboard is a question", () => {
  const asked = routeKey(CTRL_C, dash({ confirmInterrupt: true }));
  assert.equal(asked.action, "confirm:shutdown");
  assert.equal(asked.state.mode, "confirm");
  assert.equal(asked.state.confirming, "shutdown");
  // Only a single `y` confirms.
  assert.equal(routeKey("y", asked.state).action, "confirmed:shutdown");
  for (const other of ["yy", "n", CTRL_C, "\r", "q"]) {
    assert.equal(routeKey(other, asked.state).action, "confirm-cancel", `${JSON.stringify(other)} did not cancel`);
  }
});

test("CONTROL: a view that does not confirm (the tui client) still interrupts at once", () => {
  // Leaving `aify-env tui` costs nothing, so there is nothing to ask about.
  assert.equal(routeKey(CTRL_C, dash()).action, "interrupt");
  // And inside a pane Ctrl+C still belongs to the process.
  assert.equal(routeKey(CTRL_C, dash({ mode: "pty", confirmInterrupt: true })).toPty, CTRL_C);
});

// ── the session ─────────────────────────────────────────────────────────────────────────────────

const follower = () => ({ start() {}, stop() {}, status: "connecting", exit: null, lines: () => [] });

test("the session reports no interrupt until the question is answered with y", () => {
  const s = new ConsoleSession({ makeFollower: follower, confirmInterrupt: true });
  s.syncProcesses([{ id: "a" }]);
  const first = s.handleInput(CTRL_C);
  assert.equal(first.interrupt, false, "one Ctrl+C stopped everything");
  const yes = s.handleInput("y");
  assert.equal(yes.interrupt, true, "a confirmed y did not stop the environment");
});

test("THE QUESTION SURVIVES A REFRESH ON AN IDLE HOST", () => {
  // Every render reconciles the focus, and an empty process list used to reset `confirm` -- so on a
  // host with no workers the prompt would vanish on the repaint that follows the keystroke.
  const s = new ConsoleSession({ makeFollower: follower, confirmInterrupt: true });
  s.syncProcesses([]);
  s.handleInput(CTRL_C);
  s.syncProcesses([]);
  assert.equal(s.focus.mode, "confirm");
  assert.equal(s.handleInput("y").interrupt, true);
});

// ── the screen ──────────────────────────────────────────────────────────────────────────────────

const SNAPSHOT = {
  version: "0.7.0", endpoint: "http://127.0.0.1:8802", terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 2 },
  processes: [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }],
};

const frame = (view) => renderDashboard(SNAPSHOT, {
  columns: 160, keys: { enabled: true, canQuit: false },
  view: { rows: SNAPSHOT.processes, selected: 0, query: "", paneHidden: true, ...view },
}).join("\n");

test("the prompt names what is at stake: the environment and how many workers", () => {
  const text = frame({ mode: "confirm", confirming: "shutdown", confirmInterrupt: true });
  assert.match(text, /stop the environment and its 2 workers\?/);
});

test("the daemon's dashboard says what Ctrl+C does, and the tui client's does not", () => {
  assert.match(frame({ mode: "dashboard", confirmInterrupt: true }), /ctrl\+c stops everything/);
  assert.doesNotMatch(frame({ mode: "dashboard" }), /ctrl\+c stops everything/);
});

// ── end to end through the real key path ────────────────────────────────────────────────────────

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

test("THROUGH THE VIEW: Ctrl+C asks, y stops, anything else leaves the environment running", async () => {
  const input = new FakeInput();
  let stops = 0;
  const written = [];
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: (text) => written.push(text),
    clearScreen: false,
    intervalMs: 60_000,
    columns: 120,
    rows: 40,
    input,
    confirmInterrupt: true,
    onInterrupt: () => { stops += 1; },
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));

  input.emit("data", CTRL_C);
  assert.equal(stops, 0, "one Ctrl+C stopped the environment");
  assert.match(written.at(-1), /stop the environment and its 1 worker\?/);
  input.emit("data", "n");
  assert.equal(stops, 0, "a no stopped the environment");

  input.emit("data", CTRL_C);
  input.emit("data", "y");
  stop();
  assert.equal(stops, 1, "a confirmed y did not stop the environment");
});

test("the DAEMON'S view asks; it is the caller that turns the question on", async () => {
  const calls = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r",
    stdout: { isTTY: true, columns: 120, rows: 40 }, stdin: { isTTY: true },
    start: async (options) => { calls.push(options); return { stop: () => {} }; },
  });
  assert.equal(calls[0].confirmInterrupt, true);
});
