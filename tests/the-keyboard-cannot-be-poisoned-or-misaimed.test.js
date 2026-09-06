#!/usr/bin/env node
// Six defects an independent review found in the keyboard work, each pinned so it cannot come back.
//
// EVERY ONE OF THEM WAS REACHABLE BY TYPING. That is the thing to hold on to: this view now routes
// keystrokes straight into live coding agents' PTYs on the operator's own machine, so "an odd input
// confuses the cursor" and "an odd input types into the wrong agent" are the same bug wearing
// different clothes.
//
// The review ran the real code and reported inputs and outputs; each finding below was reproduced
// against these modules before anything was changed, and each test here failed first.

import assert from "node:assert/strict";
import { test } from "node:test";

import { routeKey, reconcileFocus } from "../lib/keys.mjs";
import { ConsoleSession } from "../lib/console-session.mjs";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const ENTER = "\r";

const dash = (selected = 0, count = 3, query = "") => ({ mode: "dashboard", selected, count, query });
const follower = () => ({ start() {}, stop() {}, status: "open", exit: null, lines: () => [] });
const session = (rows) => {
  const built = [];
  const s = new ConsoleSession({ makeFollower: (id) => { built.push(id); return follower(); } });
  s.syncProcesses(rows);
  return { s, built };
};
const type = (s, text) => { for (const ch of text) s.handleInput(ch); };

const FLEET = [
  { id: "p1", label: "sc-lead" },
  { id: "p2", label: "sc-coder" },
  { id: "p3", label: "sc-critic" },
];

// ── A3: the digit test was lexicographic ────────────────────────────────────────────────────────

test("POSITIVE CONTROL: a bare digit still jumps", () => {
  // Every assertion below is "this input does NOT jump". A jump branch that had stopped matching
  // anything would satisfy all of them and report green.
  assert.equal(routeKey("3", dash(0, 3)).state.selected, 2);
});

test("A MULTI-CHARACTER CHUNK IS NOT A DIGIT KEY", () => {
  // `chunk >= "1" && chunk <= "9"` is a string comparison, so "1abc", "3rd" and "2026-09-07" all
  // passed it -- and `Number("1abc")` is NaN. A CHUNK IS NOT A KEY: a paste is the ordinary way a
  // multi-character chunk arrives, and pasting a date into this view must do nothing.
  for (const chunk of ["1abc", "3rd", "2026-09-07", "9 lives"]) {
    const out = routeKey(chunk, dash(1, 3));
    assert.equal(out.action, null, `${JSON.stringify(chunk)} was treated as a jump`);
    assert.equal(out.state.selected, 1, `${JSON.stringify(chunk)} moved the selection`);
  }
});

test("a NaN selection is healed by the thing whose job is reconciling it", () => {
  // `?? 0` catches null and undefined and NOT NaN, and `Math.min(Math.max(0, NaN), n-1)` is NaN --
  // so a poisoned focus survived every refresh and every arrow key, permanently. The pane went blank
  // and the only recovery was a bare digit.
  assert.equal(reconcileFocus({ mode: "dashboard", selected: NaN, count: 3, query: "" }, 3).selected, 0);
  assert.equal(reconcileFocus({ mode: "dashboard", selected: "x", count: 3, query: "" }, 3).selected, 0);
});

// ── A2: the attach guard failed open ────────────────────────────────────────────────────────────

test("A POISONED SELECTION CANNOT ATTACH, and Ctrl+C still stops the daemon", () => {
  // `now.selected < 0` is FALSE for NaN, so a poisoned index entered `pty` mode with no process
  // under it -- and there every key, Ctrl+C included, is handed to a target that does not exist and
  // dropped. That is the "cannot stop the daemon" state the whole quit/interrupt split exists to
  // rule out, reachable from one pasted string.
  const poisoned = { mode: "dashboard", selected: NaN, count: 3, query: "" };
  const attempted = routeKey(ENTER, poisoned);
  assert.equal(attempted.action, null, "a NaN selection attached to nothing");
  assert.equal(attempted.state.mode, "dashboard");
  assert.equal(routeKey(CTRL_C, attempted.state).action, "interrupt", "Ctrl+C was swallowed");
});

// ── A4: an exiting process handed the keyboard to its neighbour ─────────────────────────────────

test("WHEN THE ATTACHED PROCESS EXITS, THE KEYBOARD LETS GO", () => {
  // THE WORST DEFECT OF THE SIX. `reconcileFocus` preserves `pty` mode and clamps the index, so:
  // attached to alpha, alpha exits, index 0 now means bravo, and the next keystroke -- a pasted
  // instruction, an Enter, a Ctrl+C -- is written into a DIFFERENT agent's live PTY with nothing on
  // screen announcing the swap. Detaching is the fail-closed answer: the process the keyboard was
  // bound to is gone, so there is nothing to re-point to.
  const { s } = session([{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }]);
  s.handleInput(ENTER);
  assert.equal(s.focus.mode, "pty");
  assert.equal(s.selected.label, "alpha");

  s.syncProcesses([{ id: "p2", label: "bravo" }]);
  assert.equal(s.focus.mode, "dashboard", "the keyboard stayed inside a pane after its process died");

  // And a keystroke now moves the cursor rather than reaching bravo.
  const out = s.handleInput("k");
  assert.equal(out.toPty, null, "a keystroke reached a process the operator never attached to");
});

test("NEGATIVE CONTROL: an unrelated process exiting does NOT detach", () => {
  // Detaching whenever the list changed would make the pane unusable on a busy host, which is the
  // opposite failure. Only the WATCHED process going away may let the keyboard go.
  const { s } = session([{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }]);
  s.handleInput(ENTER);
  s.syncProcesses([{ id: "p1", label: "alpha" }]);
  assert.equal(s.focus.mode, "pty", "an unrelated exit detached the operator");
  assert.equal(s.selected.label, "alpha");
});

// ── C1: the escape guard only covered the first byte ────────────────────────────────────────────

test("AN ESCAPE SEQUENCE IS DROPPED WHEREVER IT STARTS IN THE CHUNK", () => {
  // Testing `chunk.startsWith(ESC)` covered only the case it was written for. A read that coalesces
  // a typed character with a following arrow -- ordinary on a daemon redrawing every two seconds
  // while streaming PTYs -- delivers `a<ESC>[C` as ONE chunk, and `[C` went into the query, matched
  // nothing, and read as a broken picker.
  const pick = { mode: "picker", selected: 0, count: 3, query: "sc" };
  assert.equal(routeKey(`${ESC}[C`, pick).state.query, "sc");
  assert.equal(routeKey(`a${ESC}[C`, pick).state.query, "sca", "the sequence tail was typed");
  assert.equal(routeKey(`x${ESC}OP`, pick).state.query, "scx", "an SS3 tail was typed");
  assert.equal(routeKey(`ab${ESC}[A${ESC}[B`, pick).state.query, "scab");
});

// ── B1: accepting an empty match jumped to row 0 ────────────────────────────────────────────────

test("ACCEPTING A SEARCH THAT MATCHES NOTHING DOES NOT MOVE THE SELECTION", () => {
  // The identity re-point was skipped when `selected` was null, and `syncProcesses` then clamped -1
  // up to 0 -- landing on the FIRST agent. Same wrong answer the re-pointing was written to remove,
  // surviving in the branch nobody drove: search for something that does not exist, press Enter,
  // press Enter again, and you are attached to a process you never chose.
  const { s } = session(FLEET);
  s.handleInput("2");
  assert.equal(s.selected.label, "sc-coder");
  s.handleInput("g");
  type(s, "zzzz");
  assert.equal(s.visible().length, 0);
  s.handleInput(ENTER);
  assert.equal(s.selected.label, "sc-coder", "an empty search moved the operator to another agent");
});

test("and attaching after that empty search reaches the agent they were on", () => {
  // The consequence, driven through rather than reasoned about.
  const { s, built } = session(FLEET);
  s.handleInput("3");
  s.handleInput("g");
  type(s, "nothing-matches-this");
  s.handleInput(ENTER);
  s.handleInput(ENTER);
  assert.equal(s.focus.mode, "pty");
  assert.equal(built.at(-1), "p3", "the keyboard went into the wrong agent");
});
