#!/usr/bin/env node
// The list of agents this host could start: its keys, its state across refreshes, and what it draws.
//
// THE OPERATOR ASKED FOR THIS in these words: "spawn, start available agent". It is the half of B6
// that acts on something the dashboard is NOT showing -- agents with no process at all -- which is
// why it has its own mode, its own cursor and its own count rather than borrowing the process list's.
//
// THREE FAILURES ARE WORTH MORE THAN THE REST, and each has a test that names it:
//
//   an unanswered list drawn as an empty one -- the false green this project keeps finding
//   the mode closing on an idle host -- the exact host most likely to want it
//   Enter naming the first agent instead of the chosen one -- the router resets the cursor on the
//   way out, so reading it a line too late is silently always row 0

import assert from "node:assert/strict";
import test from "node:test";

import { MODES, initialFocus, reconcileFocus, routeKey } from "../lib/keys.mjs";
import { ConsoleSession } from "../lib/console-session.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const ENTER = String.fromCharCode(13);
const DETACH = String.fromCharCode(29);
const UP = `${String.fromCharCode(27)}[A`;
const DOWN = `${String.fromCharCode(27)}[B`;

const dash = (count = 3) => ({ ...initialFocus(count), count, selected: 0 });

// ── the keys ─────────────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: `s` opens the start list from the dashboard", () => {
  const { state, action } = routeKey("s", dash());
  assert.equal(action, "start-open");
  assert.equal(state.mode, "start");
  assert.equal(state.startAt, 0);
});

test("`start` IS A DECLARED MODE, so reconciling cannot drop it by hand-typed omission", () => {
  // `reconcileFocus` lost `menu` and `confirm` this way once, within an hour of shipping, because
  // its survivor list was written out by hand. The declared set is what it consults now.
  assert.ok(MODES.includes("start"));
});

test("IT OPENS EVEN WITH NOTHING TO SHOW, unlike the actions menu", () => {
  // An empty actions menu would offer to stop a process that does not exist. An empty start list is
  // a real answer -- every agent already has a worker -- and the operator asked the question.
  // Refusing to open reads as the key not working, which is the one thing the screen must never do.
  const { state, action } = routeKey("s", { ...initialFocus(0), count: 0, selected: -1 });
  assert.equal(action, "start-open");
  assert.equal(state.mode, "start");
});

test("THE START CURSOR NEVER MOVES THE PROCESS SELECTION", () => {
  // They are indexes into different lists. Moving `selected` here would slide the pane -- and the
  // agent an operator is watching -- underneath a list that has nothing to do with it.
  const open = { ...dash(3), mode: "start", startAt: 0, startCount: 4, selected: 2 };
  const moved = routeKey(DOWN, open);
  assert.equal(moved.state.startAt, 1);
  assert.equal(moved.state.selected, 2, "the process selection moved");
  assert.equal(moved.action, "start-move");
  // WRAPS, like every other cursor in this view.
  assert.equal(routeKey(UP, { ...open, startAt: 0 }).state.startAt, 3);
});

test("`j` AND `k` MOVE HERE, because there is nothing to type into", () => {
  const open = { ...dash(3), mode: "start", startAt: 0, startCount: 3 };
  assert.equal(routeKey("j", open).state.startAt, 1);
  assert.equal(routeKey("k", open).state.startAt, 2);
});

test("ENTER ON AN EMPTY LIST REPORTS NOTHING, rather than choosing row 0 of nothing", () => {
  // Reporting a choice for an empty list is how a caller ends up starting `undefined`.
  const { action } = routeKey(ENTER, { ...dash(3), mode: "start", startAt: 0, startCount: 0 });
  assert.equal(action, null);
  // POSITIVE CONTROL: with rows, Enter chooses.
  assert.equal(routeKey(ENTER, { ...dash(3), mode: "start", startAt: 0, startCount: 2 }).action, "chose:start");
});

test("STARTING DOES NOT CONFIRM, and that follows the rule rather than excusing itself from it", () => {
  // `DESTRUCTIVE` is derived from "ends work the operator cannot get back". Starting an agent that
  // has no worker ends nothing, and the stop that undoes it is one menu away. It still takes three
  // deliberate keystrokes, which is the distance the actions menu keeps.
  const { state, action } = routeKey(ENTER, { ...dash(3), mode: "start", startAt: 1, startCount: 2 });
  assert.equal(action, "chose:start");
  assert.equal(state.mode, "dashboard", "choosing left the operator somewhere other than the dashboard");
  assert.equal(state.confirming ?? null, null);
});

test("EVERY OTHER KEY IS INERT IN THE LIST, so nothing acts on the dashboard behind it", () => {
  const open = { ...dash(3), mode: "start", startAt: 0, startCount: 2 };
  for (const key of ["q", "1", "m", "p", "g", "x"]) {
    const { state, action } = routeKey(key, open);
    assert.equal(action, null, `${key} did something in the start list`);
    assert.equal(state.mode, "start");
  }
  // POSITIVE CONTROL: the two keys that DO work here still work.
  assert.equal(routeKey(DETACH, open).action, "start-close");
  assert.equal(routeKey(String.fromCharCode(3), open).action, "interrupt");
});

test("THE MODE SURVIVES AN EMPTY PROCESS LIST, which is the host it exists for", () => {
  // Its rows are agents with NO process, so a host running nothing is exactly when an operator opens
  // it. The menu and the pane close on an empty list for the opposite and correct reason: they act
  // on a row. Closing this one would make the feature unreachable where it is most wanted.
  const open = { ...dash(0), mode: "start", startAt: 2, startCount: 5, count: 0, selected: -1 };
  const after = reconcileFocus(open, 0);
  assert.equal(after.mode, "start");
  assert.equal(after.startAt, 2, "the cursor was reset under the operator's hand");
  assert.equal(after.startCount, 5);
  // NEGATIVE CONTROL: the menu still closes, so this is not a blanket "everything survives".
  assert.equal(reconcileFocus({ ...open, mode: "menu" }, 0).mode, "dashboard");
});

test("THE CURSOR AND THE COUNT SURVIVE A REDRAW, which this rebuild has dropped three fields to", () => {
  // `paneHidden`, then `confirming`, then `menuActions` -- each rebuilt as a literal and each
  // forgotten once. A dropped `startCount` makes Enter report nothing on a list the operator can see.
  const after = reconcileFocus({ ...dash(3), mode: "start", startAt: 2, startCount: 4 }, 3);
  assert.equal(after.startAt, 2);
  assert.equal(after.startCount, 4);
});

// ── the session ──────────────────────────────────────────────────────────────────────────────────

function session() {
  return new ConsoleSession({ endpoint: "http://127.0.0.1:8802", makeFollower: () => ({ stop() {}, lines: () => [] }) });
}

test("POSITIVE CONTROL: a supplied list becomes the count the router wraps on", () => {
  const s = session();
  s.noteStartable([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(s.focus.startCount, 3);
  assert.deepEqual(s.startView().agents.map((r) => r.id), ["a", "b", "c"]);
});

test("ENTER NAMES THE AGENT UNDER THE CURSOR, not the first one", () => {
  // The router resets `startAt` to 0 on the way out, so reading it from the NEW state would silently
  // name row 0 every time -- and every test that only checked "an agent was chosen" would pass.
  const s = session();
  s.noteStartable([{ id: "alpha" }, { id: "bravo" }, { id: "charlie" }]);
  s.handleInput("s");
  s.noteStartable([{ id: "alpha" }, { id: "bravo" }, { id: "charlie" }]);
  s.handleInput(DOWN);
  s.handleInput(DOWN);
  const result = s.handleInput(ENTER);
  assert.equal(result.action, "chose:start");
  assert.equal(result.startAgent?.id, "charlie");
});

test("A CHOICE IS NOT A `perform`, because that one carries a PROCESS", () => {
  // Folding them together would need a fake process object, and every executor downstream would have
  // to tell the two apart by inspecting it. These agents have no process; that is the whole point.
  const s = session();
  s.noteStartable([{ id: "alpha" }]);
  s.handleInput("s");
  s.noteStartable([{ id: "alpha" }]);
  const result = s.handleInput(ENTER);
  assert.equal(result.perform, null);
  assert.equal(result.startAgent.id, "alpha");
});

test("AN UNANSWERED LIST IS NOT AN EMPTY ONE, and opening it marks it unanswered again", () => {
  // The false green: the screen announcing "nothing to start" while the request is still in flight.
  // And rows from the last time it was open are stale by however long it has been closed, so an
  // operator could choose an agent that came up ten minutes ago.
  const s = session();
  assert.equal(s.startView().asked, false, "a session that has asked nothing reported an answer");
  s.noteStartable([{ id: "a" }]);
  assert.equal(s.startView().asked, true);
  s.handleInput("s");
  assert.equal(s.startView().asked, false, "reopening the list kept the previous answer as current");
});

test("THE CURSOR IS CLAMPED WHEN THE LIST SHRINKS, not reset", () => {
  // Agents come and go while the list is open. Jumping to the top under the operator's hand is the
  // same defect the process list's clamping exists to avoid.
  const s = session();
  s.noteStartable([{ id: "a" }, { id: "b" }, { id: "c" }]);
  s.focus = { ...s.focus, startAt: 2 };
  s.noteStartable([{ id: "a" }, { id: "b" }]);
  assert.equal(s.focus.startAt, 1);
  s.noteStartable([]);
  assert.equal(s.focus.startAt, 0, "an empty list left the cursor pointing past its end");
});

test("ROWS WITHOUT AN ID ARE DROPPED, because a row nobody can start is a row nobody should choose", () => {
  const s = session();
  s.noteStartable([{ id: "a" }, {}, null, { name: "no id" }, { id: "" }]);
  assert.deepEqual(s.startView().agents.map((r) => r.id), ["a"]);
  assert.equal(s.focus.startCount, 1);
});

// ── what it draws ────────────────────────────────────────────────────────────────────────────────

const SNAPSHOT = {
  version: "0.6.3", build: "abc", endpoint: "http://127.0.0.1:8802",
  processes: [], services: [], checks: [], history: { startedTotal: 0 },
  terminals: { available: true },
};

function drawn(start, { processes = [] } = {}) {
  return renderDashboard({ ...SNAPSHOT, processes }, {
    columns: 100, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: processes, selected: 0, mode: "start", query: "", start },
  }).join("\n");
}

test("POSITIVE CONTROL: the agents are drawn, with the cursor on the chosen row", () => {
  const text = drawn({ agents: [{ id: "alpha", name: "alpha", status: "available", runtime: "claude-code" },
    { id: "bravo", name: "bravo", status: "stopped", runtime: "pi" }], at: 1, problem: "", asked: true });
  assert.match(text, /start an agent on this host/);
  assert.match(text, /alpha/);
  assert.match(text, /❯ bravo/, "the cursor is not on the selected row");
  // THE STATUS TRAVELS WITH THE NAME. `available` and `stopped` are different decisions for an
  // operator, and choosing between them from names alone is choosing blind.
  assert.match(text, /stopped/);
});

test("AN UNANSWERED LIST SAYS SO, rather than claiming there is nothing to start", () => {
  const asking = drawn({ agents: [], at: 0, problem: "", asked: false });
  assert.match(asking, /asking aify-comms/);
  assert.doesNotMatch(asking, /nothing to start/);
  // POSITIVE CONTROL: an ANSWERED empty list does say there is nothing.
  const answered = drawn({ agents: [], at: 0, problem: "", asked: true });
  assert.match(answered, /nothing to start/);
});

test("A PROBLEM IS DRAWN INSTEAD OF A FALSE 'NOTHING TO START'", () => {
  // Those two render identically as an empty list, and one of them means the operator should look at
  // aify-comms rather than at their agents.
  const text = drawn({ agents: [], at: 0, problem: "aify-comms did not answer: ECONNREFUSED", asked: true });
  assert.match(text, /ECONNREFUSED/);
  assert.doesNotMatch(text, /nothing to start/);
});

test("IT DRAWS ON A HOST RUNNING NOTHING, which is the host most likely to want it", () => {
  // The render sat inside the populated-table branch when it was first written, so an idle host --
  // the one whose agents all need starting -- would have pressed `s` and seen nothing at all.
  const text = drawn({ agents: [{ id: "alpha", name: "alpha", status: "available" }], at: 0, problem: "", asked: true },
    { processes: [] });
  assert.match(text, /start an agent on this host/);
  assert.match(text, /alpha/);
});

test("NOTHING IS DRAWN IN ANY OTHER MODE, so the list cannot leak onto the dashboard", () => {
  const text = renderDashboard(SNAPSHOT, {
    columns: 100, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: [], selected: 0, mode: "dashboard", query: "", start: { agents: [{ id: "alpha", name: "alpha" }], at: 0, problem: "", asked: true } },
  }).join("\n");
  assert.doesNotMatch(text, /start an agent on this host/);
});

console.log("start-list.test.js: all assertions passed");
