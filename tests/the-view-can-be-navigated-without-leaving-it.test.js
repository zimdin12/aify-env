#!/usr/bin/env node
// Switching between agents from inside the view: jump-to-number, the picker, and the quit/interrupt
// split the daemon's terminal depends on.
//
// THE OPERATOR'S ASK, 2026-09-06: "how can i switch between agent tuis from within the aify-env. i
// asked herdr like usability." The answer at the time was that they could not -- the daemon's own
// view is handed no keyboard at all, and the only navigation anywhere was one cursor and Enter.
//
// WHAT HERDR ACTUALLY BINDS, read from its own docs rather than from our description of it:
// `prefix+1..9` jumps to a tab, `prefix+g` opens a goto picker, `prefix+b` toggles a sidebar listing
// agents by status, `prefix+q` detaches. It is tmux-shaped: a prefix, panes, splits, tabs, mouse.
//
// WHAT WE TAKE AND WHAT WE LEAVE. The jump and the picker are the two that answer "I have nine
// agents and I want that one", which is the ask. There is no prefix here because there is nothing to
// prefix AWAY from: every byte meant for a process goes through `pty` mode, so the dashboard's
// keyboard is uncontested. Panes, splits and mouse are a different product and are deliberately not
// attempted -- half a tmux is worse than none.
//
// THE QUIT/INTERRUPT SPLIT IS THE LOAD-BEARING ONE. `q` and Ctrl+C were a single "quit" action, and
// the whole reason the daemon's view had no keyboard is that raw mode would then either swallow
// Ctrl+C -- leaving no way to stop the daemon from its own terminal -- or make a stray `q` end every
// managed agent on the host. Two actions, and the caller says what each means.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DETACH, initialFocus, reconcileFocus, routeKey } from "../lib/keys.mjs";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);
const ENTER = "\r";

const dash = (selected = 0, count = 4, query = "") => ({ mode: "dashboard", selected, count, query });
const picking = (selected = 0, count = 4, query = "") => ({ mode: "picker", selected, count, query });

// ── jump to a number ────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: the dashboard still routes the keys it always did", () => {
  // Every assertion below is "this new key does something". A routeKey that had stopped matching
  // anything would satisfy the out-of-range and unbound cases perfectly and report green.
  assert.equal(routeKey(DOWN, dash(0, 4)).state.selected, 1);
  assert.equal(routeKey(ENTER, dash(0, 4)).action, "attach");
});

test("a digit selects that row outright", () => {
  assert.equal(routeKey("1", dash(3, 9)).state.selected, 0);
  assert.equal(routeKey("4", dash(0, 9)).state.selected, 3);
  assert.equal(routeKey("9", dash(0, 9)).state.selected, 8);
  assert.equal(routeKey("3", dash(0, 9)).action, "move");
});

test("a digit past the end of the list does NOTHING, rather than clamping", () => {
  // Clamping would make 4, 5, 6, 7, 8 and 9 all silently mean "the third one" on a host running
  // three agents -- worse than nothing happening, because the operator would believe they had
  // jumped somewhere and would then type at whatever was under the old selection.
  const before = dash(1, 3);
  const after = routeKey("7", before);
  assert.equal(after.state.selected, 1, "the selection moved to a row that does not exist");
  assert.equal(after.action, null);
});

test("a digit SELECTS and does not attach", () => {
  // The pane already follows the selection, so a digit shows that agent immediately. Attaching as
  // well would put the keyboard inside a process from one keystroke.
  assert.equal(routeKey("2", dash(0, 4)).state.mode, "dashboard");
  assert.equal(routeKey("2", dash(0, 4)).toPty, null);
});

test("0 is not a jump, because there is no row zero on a 1-based list", () => {
  assert.equal(routeKey("0", dash(1, 4)).action, null);
});

// ── the picker ──────────────────────────────────────────────────────────────────────────────────

test("g opens the picker with an empty query", () => {
  const out = routeKey("g", dash(2, 4));
  assert.equal(out.state.mode, "picker");
  assert.equal(out.state.query, "");
  assert.equal(out.action, "picker-open");
  assert.equal(out.state.selected, 2, "opening the picker moved the selection");
});

test("typing builds the query, backspace takes it back", () => {
  let state = picking(0, 4, "");
  for (const ch of "sc-c") state = routeKey(ch, state).state;
  assert.equal(state.query, "sc-c");
  state = routeKey(String.fromCharCode(127), state).state;
  assert.equal(state.query, "sc-");
  state = routeKey(String.fromCharCode(8), state).state;
  assert.equal(state.query, "sc", "the other backspace byte was not handled");
});

test("j and k are TEXT in the picker, not movement", () => {
  // The whole reason the picker needs its own mode rather than a flag on the dashboard one.
  const out = routeKey("k", picking(0, 4, "s"));
  assert.equal(out.state.query, "sk");
  assert.equal(out.state.selected, 0, "a letter moved the selection");
});

test("digits are text in the picker too", () => {
  assert.equal(routeKey("2", picking(0, 4, "gpt-")).state.query, "gpt-2");
});

test("arrows still move in the picker", () => {
  assert.equal(routeKey(DOWN, picking(0, 4, "sc")).state.selected, 1);
  assert.equal(routeKey(UP, picking(0, 4, "sc")).state.selected, 3, "movement does not wrap");
});

test("an escape sequence is not typed into the query", () => {
  // An arrow that fell through to the printable branch would put a literal `[A` in the filter, match
  // nothing, and read as "the picker is broken". ESC is the first byte of every one of them.
  const out = routeKey(`${ESC}[C`, picking(0, 4, "sc"));
  assert.equal(out.state.query, "sc");
});

test("Enter accepts: the picker closes and the selection is kept", () => {
  const out = routeKey(ENTER, picking(2, 4, "sc-cr"));
  assert.equal(out.state.mode, "dashboard");
  assert.equal(out.state.selected, 2);
  assert.equal(out.state.query, "", "the filter outlived its own picker");
  assert.equal(out.action, "picker-accept");
});

test("Ctrl+] closes the picker and drops the filter", () => {
  // The one way back, from every mode -- the same key that leaves the pane. An operator learns it
  // once. ESC cannot do this job here for exactly the reason it cannot do it in the pane.
  const out = routeKey(DETACH, picking(1, 4, "tester"));
  assert.equal(out.state.mode, "dashboard");
  assert.equal(out.state.query, "");
  assert.equal(out.action, "picker-close");
});

test("a picker over an empty list stays open", () => {
  // A pane with nothing under it swallows keys and sends them nowhere, so it closes. A picker
  // matching nothing is a search that currently matches nothing, which is a fine thing to be
  // looking at while a host is starting work.
  const out = reconcileFocus(picking(0, 4, "sc"), 0);
  assert.equal(out.mode, "picker");
  assert.equal(out.query, "sc", "the query was dropped when the list emptied");
  assert.equal(out.selected, -1);
});

// ── quit vs interrupt ───────────────────────────────────────────────────────────────────────────

test("Ctrl+C is an INTERRUPT and q is a QUIT, in every dashboard state", () => {
  assert.equal(routeKey(CTRL_C, dash(0, 4)).action, "interrupt");
  assert.equal(routeKey("q", dash(0, 4)).action, "quit");
  assert.equal(routeKey(CTRL_C, dash(-1, 0)).action, "interrupt", "an empty host still interrupts");
});

test("Ctrl+C in the PICKER is still an interrupt", () => {
  // Otherwise an operator who opened the picker on a runaway host would have to work out how to
  // close it before they could stop anything.
  assert.equal(routeKey(CTRL_C, picking(0, 4, "sc")).action, "interrupt");
});

test("NEGATIVE CONTROL: Ctrl+C inside the PANE still reaches the process", () => {
  // The one place it must NOT be an action. An agent needs to interrupt its own work, and a pane
  // that swallowed Ctrl+C would be a worse terminal than the one it replaces.
  const out = routeKey(CTRL_C, { mode: "pty", selected: 0, count: 4, query: "" });
  assert.equal(out.action, null);
  assert.equal(out.toPty, CTRL_C);
});

test("NEGATIVE CONTROL: digits and g inside the PANE reach the process untouched", () => {
  // Every new dashboard binding is a key an agent might legitimately be typed at. None of them may
  // be intercepted once the keyboard belongs to a process.
  for (const key of ["1", "9", "g", "q"]) {
    const out = routeKey(key, { mode: "pty", selected: 0, count: 4, query: "" });
    assert.equal(out.toPty, key, `${key} was swallowed by the pane`);
    assert.equal(out.action, null);
  }
});

test("initialFocus carries a query, so a picker has somewhere to start", () => {
  assert.equal(initialFocus(3).query, "");
});
