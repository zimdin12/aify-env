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
  assert.deepEqual(initialFocus(0),
    { mode: "dashboard", selected: -1, count: 0, query: "", paneHidden: true });
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
  // `paneHidden` goes back to the default here because there is nothing left to show in a pane.
  assert.deepEqual(reconcileFocus(pty(2, 3), 0),
    { mode: "dashboard", selected: -1, count: 0, query: "", paneHidden: true });
});

test("reconciling keeps pty mode while there is still something to show", () => {
  assert.equal(reconcileFocus(pty(0, 3), 3).mode, "pty");
});

// ── the pane toggle ─────────────────────────────────────────────────────────────────

test("the pane starts HIDDEN, which is the operator's stated priority", () => {
  // "I would rather see more agents and less notices, the most useful thing in this is that I see
  // what agent is working and what not." The pane costs half the width to show one process.
  assert.equal(initialFocus(0).paneHidden, true);
  assert.equal(initialFocus(3).paneHidden, true);
});

test("`p` shows the pane, and `p` again hides it", () => {
  const shown = routeKey("p", dash(0, 3));
  assert.equal(shown.state.paneHidden, false);
  assert.equal(shown.action, "pane-toggle");
  assert.equal(routeKey("p", shown.state).state.paneHidden, true);
});

test("toggling changes NOTHING else -- not the mode, the selection or the query", () => {
  // A view key. If it moved the selection the operator would lose their place every time they looked
  // at a console, which is the opposite of what it is for.
  const before = { mode: "dashboard", selected: 2, count: 5, query: "" };
  const after = routeKey("p", before).state;
  assert.equal(after.mode, "dashboard");
  assert.equal(after.selected, 2);
  assert.equal(after.count, 5);
});

test("THE TOGGLE SURVIVES A REFRESH, which is where a new field goes to die", () => {
  // `reconcileFocus` rebuilds the state as a literal on both of its return paths, so a field not
  // named in BOTH is silently reset. This view reconciles every two seconds against a fresh
  // snapshot -- so a dropped flag would put the pane back within one refresh and read to the
  // operator as the key not working at all.
  const shown = routeKey("p", dash(0, 3)).state;
  assert.equal(shown.paneHidden, false, "precondition: the toggle worked");
  assert.equal(reconcileFocus(shown, 3).paneHidden, false, "a refresh re-hid the pane");
  assert.equal(reconcileFocus(shown, 7).paneHidden, false, "a list that GREW re-hid the pane");
});

test("a state that predates this field gets the DEFAULT, not undefined", () => {
  // The daemon builds a focus, tests hand it literals, and every one written before `paneHidden`
  // existed has no such key. Falling back to `initialFocus`'s answer keeps them agreeing with a
  // fresh session instead of quietly getting the other layout.
  assert.equal(reconcileFocus({ mode: "dashboard", selected: 0, count: 3 }, 3).paneHidden, true);
  assert.equal(reconcileFocus(undefined, 3).paneHidden, true);
});

test("ATTACHING SHOWS THE PANE, because typing into one nobody can see is not a feature", () => {
  // Enter with the pane hidden would hand the keyboard to a real process whose output is off screen:
  // every key lands somewhere and nothing visibly happens, which is indistinguishable from a frozen
  // view. This is the same defect as blind input, reached from the other side.
  // ENTER AS A CODE POINT, not an escape: this file already spells its control keys this way
  // (see CTRL_C above), and a literal CR in a source string is invisible in every diff.
  const attached = routeKey(String.fromCharCode(13), dash(1, 3));
  assert.equal(attached.action, "attach");
  assert.equal(attached.state.mode, "pty");
  assert.equal(attached.state.paneHidden, false);
});

test("a refresh cannot re-hide the pane while ATTACHED", () => {
  // Enforced at reconcile and not only at the moment of attaching, because `pty` mode can arrive
  // here with the flag set from anywhere -- a daemon-built state, a future caller.
  assert.equal(reconcileFocus({ mode: "pty", selected: 0, count: 3, paneHidden: true }, 3).paneHidden,
    false);
});

test("`p` is a LETTER in the picker and in the pane, not a toggle", () => {
  // The reason those modes return before the dashboard block rather than testing a flag there.
  const typed = routeKey("p", { mode: "picker", selected: 0, count: 3, query: "hel" });
  assert.equal(typed.state.query, "help");
  assert.equal(typed.action, "query");

  const sent = routeKey("p", pty(0, 3));
  assert.equal(sent.toPty, "p", "`p` was swallowed instead of reaching the process");
  assert.equal(sent.action, null);
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
