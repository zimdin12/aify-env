// Keyboard routing for the per-terminal pane: dashboard keys versus process input.
//
// PURE, so every rule is testable by calling a function -- no terminal, no raw mode, no process. That
// separation is the reason a routing table this fiddly can be trusted at all.

import assert from "node:assert/strict";
import test from "node:test";

import { DETACH, initialFocus, reconcileFocus, routeKey } from "../lib/keys.mjs";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);
const dash = (selected = 0, count = 3) => ({ mode: "dashboard", selected, count });
const pty = (selected = 0, count = 3) => ({ mode: "pty", selected, count });

// ── initialFocus / reconcileFocus ───────────────────────────────────────────────────────────────

test("an empty host selects nothing rather than index 0", () => {
  assert.deepEqual(initialFocus(0), { mode: "dashboard", selected: -1, count: 0, query: "" });
  assert.equal(initialFocus(3).selected, 0);
});

test("the selection is CLAMPED when the process list shrinks, not reset", () => {
  // Processes come and go while the pane is open -- that is the normal case, since watching work start
  // and finish is the point of the view. Jumping back to the top on every spawn would make it unusable
  // on a busy host.
  assert.equal(reconcileFocus(dash(5, 6), 3).selected, 2);
  assert.equal(reconcileFocus(dash(1, 6), 6).selected, 1, "a valid selection was moved");
});

test("when the last process goes, the pane closes rather than pointing at nothing", () => {
  assert.deepEqual(reconcileFocus(pty(2, 3), 0), { mode: "dashboard", selected: -1, count: 0, query: "" });
});

test("reconciling keeps pty mode while there is still something to show", () => {
  assert.equal(reconcileFocus(pty(0, 3), 3).mode, "pty");
});

// ── dashboard mode ──────────────────────────────────────────────────────────────────────────────

test("arrows and jk move the selection, and it WRAPS", () => {
  // An operator holding a key down should not have to notice they hit the bottom.
  assert.equal(routeKey(DOWN, dash(2, 3)).state.selected, 0);
  assert.equal(routeKey(UP, dash(0, 3)).state.selected, 2);
  assert.equal(routeKey("j", dash(0, 3)).state.selected, 1);
  assert.equal(routeKey("k", dash(1, 3)).state.selected, 0);
});

test("Enter attaches to the selected process", () => {
  const out = routeKey("\r", dash(1, 3));
  assert.equal(out.action, "attach");
  assert.equal(out.state.mode, "pty");
  assert.equal(out.state.selected, 1);
});

test("Enter with NOTHING to attach to does nothing at all", () => {
  // Entering pty mode with no selection hands the operator a pane that swallows their keys and sends
  // them nowhere -- a dead terminal that looks live.
  const out = routeKey("\r", { mode: "dashboard", selected: -1, count: 0 });
  assert.equal(out.action, null);
  assert.equal(out.state.mode, "dashboard");
});

test("q and Ctrl+C are DIFFERENT actions, and the daemon depends on that", () => {
  // They were one action, which is right for `aify-env tui` and wrong for the daemon rendering the
  // same view: there Ctrl+C means "stop the environment and take its managed processes with it".
  // One action gave two ways to be wrong -- swallow Ctrl+C and the daemon cannot be stopped from
  // its own terminal, or honour `q` the same way and one stray keystroke reaps every agent.
  assert.equal(routeKey("q", dash()).action, "quit");
  assert.equal(routeKey(CTRL_C, dash()).action, "interrupt");
});

test("an unbound key in dashboard mode is ignored, not forwarded anywhere", () => {
  const out = routeKey("z", dash());
  assert.equal(out.action, null);
  assert.equal(out.toPty, null);
});

// ── pty mode: the pane is a terminal ────────────────────────────────────────────────────────────

test("CTRL+C REACHES THE PROCESS, it does not quit the dashboard", () => {
  // The single most important routing rule here. An agent needs to interrupt its own work; a pane that
  // swallowed Ctrl+C would be a worse terminal than the one it replaces.
  const out = routeKey(CTRL_C, pty());
  assert.equal(out.toPty, CTRL_C);
  assert.equal(out.action, null);
  assert.equal(out.state.mode, "pty", "Ctrl+C detached the pane");
});

test("q reaches the process too — it is a letter, not a command, once attached", () => {
  assert.equal(routeKey("q", pty()).toPty, "q");
});

test("arrow keys reach the process WHOLE, never as three separate bytes", () => {
  // A terminal delivers whatever arrived since the last read. Splitting ESC [ A into three decisions is
  // how an arrow key becomes an escape followed by garbage.
  assert.equal(routeKey(UP, pty()).toPty, UP);
});

test("Ctrl+] detaches, and hands the keyboard back to the dashboard", () => {
  const out = routeKey(DETACH, pty(1, 3));
  assert.equal(out.action, "detach");
  assert.equal(out.state.mode, "dashboard");
  assert.equal(out.state.selected, 1, "detaching lost the selection");
  assert.equal(out.toPty, null, "the detach byte was also sent to the process");
});

test("THE DETACH KEY IS NOT ESCAPE, because ESC begins every arrow key", () => {
  // The escape-ambiguity trap: `ESC` is the first byte of `ESC [ A`. Detaching on a bare ESC would fire
  // whenever the operator pressed an arrow inside the pane, or need a timer to guess whether more bytes
  // were coming. This asserts the choice rather than leaving it to be re-litigated.
  const out = routeKey(ESC, pty());
  assert.equal(out.state.mode, "pty", "a bare ESC detached the pane");
  assert.equal(out.toPty, ESC, "a bare ESC was swallowed instead of reaching the process");
});

test("a PASTE containing the detach byte is data, not a command", () => {
  // Only a chunk that IS the detach byte detaches. Treating "contains" as "is" would silently drop the
  // rest of a paste the process asked for.
  const paste = `hello${DETACH}world`;
  const out = routeKey(paste, pty());
  assert.equal(out.toPty, paste);
  assert.equal(out.state.mode, "pty");
});

test("a multi-character paste is forwarded in one piece", () => {
  const paste = "git status\r";
  assert.equal(routeKey(paste, pty()).toPty, paste);
});

test("empty input changes nothing", () => {
  for (const value of ["", null, undefined]) {
    const out = routeKey(value, pty(1, 3));
    assert.equal(out.toPty, null);
    assert.equal(out.action, null);
  }
});

test("a missing state does not throw — it falls back to an empty dashboard", () => {
  const out = routeKey("j", null);
  assert.equal(out.state.mode, "dashboard");
  assert.equal(out.action, null, "it moved a selection in an empty list");
});
