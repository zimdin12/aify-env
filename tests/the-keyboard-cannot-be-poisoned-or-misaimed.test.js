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
  // A DRAWABLE TERMINAL, because attaching is refused without one. `canDrawPane` fails closed on an
  // unreported width: a session that cannot show a pane must not forward keys into a live PTY, and a
  // caller that forgets to report loses attach VISIBLY rather than gaining invisible input. Every
  // test in this file drives the keyboard, so every one of them needs a terminal to drive it on.
  s.noteViewport({ columns: 100 });
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

// ── the fourth wrong-subject defect, and it arrived with the fix for the third ───────────────────
//
// Performing `attach` inside the router made the menu's own default work -- it had been inert,
// because every executor handles `stop` and none of them knows what attaching means. But the router
// is PURE: it moves the keyboard by mode and cannot resolve an identity, so the subject fell back to
// the cursor while every other menu action resolves by the id captured when the menu opened.
//
// The two agree until the list shifts, which it does every two seconds on a busy host.

test("ATTACHING FROM THE MENU GOES TO THE AGENT THE MENU NAMED, not to the cursor", () => {
  // MEASURED by review through the real daemon adapter: menu opened on bravo, alpha exits, the
  // prompt still reads "actions for bravo", and `runner.write` receives charlie's id.
  const { s } = session(FLEET);
  s.handleInput(ESC + "[B");                       // cursor to p2
  s.handleInput("m");                              // menu bound to p2
  assert.equal(s.actionTargetId, "p2", "positive control: the menu did not bind a subject");
  s.syncProcesses(FLEET.slice(1));                 // p1 exits; index 1 is now p3
  const result = s.handleInput(ENTER);             // Enter on `attach`
  assert.equal(result.action, "attach");
  assert.equal(s.selected?.id, "p2", "the keyboard went to the row that took the target's place");
});

test("AND ON A PANE THAT IS ALREADY FOLLOWING SOMETHING, which is where the reconcile undid it", () => {
  // THE SAME CHOICE, WITH THE PANE REVEALED, and it went to a different agent. The test above
  // passes on a HIDDEN pane -- nothing is being followed, so nothing reconciles -- and review
  // found the case it cannot reach: reveal the pane, let the list shift so the pane is following
  // p3, and the menu's identity choice is overwritten on the way out.
  //
  // `attach` is in RESELECTING_ACTIONS, so `syncProcesses` runs straight after the menu block,
  // and its rule for a pty-mode pane is to keep the keyboard on the process it is ALREADY bound
  // to when rows shift. That rule protects an existing binding; an explicit Attach is a NEW one.
  const { s } = session(FLEET);
  s.handleInput(ENTER);                            // attach to p1, revealing the pane
  s.handleInput(String.fromCharCode(29));     // back to the dashboard
  s.handleInput(ESC + "[B");                       // cursor to p2
  s.handleInput("m");                              // menu bound to p2
  assert.equal(s.actionTargetId, "p2", "positive control: the menu did not bind a subject");
  s.syncProcesses(FLEET.slice(1));                 // p1 exits; the pane follows p3 now
  assert.equal(s.watchedId, "p3", "positive control: the pane really did shift under the cursor");
  const result = s.handleInput(ENTER);             // Enter on `attach`
  assert.equal(result.action, "attach");
  assert.equal(s.selected?.id, "p2", "the keyboard went to the agent the MENU named");
  assert.equal(s.watchedId, "p2", "and the pane follows that agent, not the one it was on");
});

test("A REVEALED PANE ATTACHING TO WHAT IT IS ALREADY WATCHING KEEPS WATCHING IT", () => {
  // The control for the fix above: closing the old binding on every menu attach would also close
  // one the operator did not change, so this asks for the no-op case and expects continuity.
  const { s } = session(FLEET);
  s.handleInput(ENTER);
  s.handleInput(String.fromCharCode(29));
  s.handleInput("m");                              // menu bound to p1, which is what we watch
  const result = s.handleInput(ENTER);
  assert.equal(result.action, "attach");
  assert.equal(s.selected?.id, "p1");
  assert.equal(s.watchedId, "p1", "the pane still follows the agent it was already on");
});

test("A TARGET THAT VANISHED REFUSES THE ATTACH, rather than taking whoever replaced it", () => {
  // Gone means refused, exactly as it does for stop. Attaching to whichever row moved into that
  // position is the same wrong-subject bug in a harmless-looking costume: the operator types into
  // somebody else's session believing it is the one they chose.
  const { s } = session(FLEET);
  s.handleInput(ESC + "[B");
  s.handleInput("m");
  s.syncProcesses([FLEET[0], FLEET[2]]);           // p2 itself is gone
  const result = s.handleInput(ENTER);
  assert.equal(result.action, "attach-refused");
  assert.equal(s.focus.mode, "dashboard");
});

test("ATTACHING FROM THE DASHBOARD STILL FOLLOWS THE CURSOR", () => {
  // The two paths resolve differently ON PURPOSE, and this is the control that keeps the fix from
  // being "attach is broken everywhere". Enter on the dashboard is a choice made at that instant;
  // Enter in a menu is a choice made when the menu opened.
  const { s } = session(FLEET);
  s.handleInput(ESC + "[B");
  const result = s.handleInput(ENTER);
  assert.equal(result.action, "attach");
  assert.equal(s.selected?.id, "p2");
  assert.equal(s.focus.mode, "pty");
});

test("THE MENU'S SUBJECT IS RELEASED BY ATTACHING, like every other way out of it", () => {
  // A subject left bound after the menu closed is one a LATER confirmation could resolve against --
  // the same stale-target shape from the other end.
  const { s } = session(FLEET);
  s.handleInput("m");
  s.handleInput(ENTER);
  assert.equal(s.actionTargetId, null, "the menu's target outlived the menu");
});

// ── readiness was an observation of the past read beside a fact of the present ───────────────────
//
// `paneRendered` says a frame reached the screen. It does not say WHICH frame -- and the follower's
// problem was being read LIVE beside it, so the two described different moments.
//
// REVIEW'S REPRO, with a real dashboard, session, follower and parser: display alpha's baseline
// refusal, hold the health refresh, then deliver RIS and visible text and let it parse. Enter and a
// keystroke reached alpha while the accepted frame count stayed at 3 and the last thing displayed was
// still the refusal. The operator is typing at a screen that says they are not seeing the process.

const refusingFollower = (problem) => ({
  status: "streaming",
  start() {}, stop() {},
  lines: () => ["something"],
  paneProblem: () => problem.value,
});

test("A RECOVERED STREAM DOES NOT UNLOCK INPUT UNTIL A FRAME SHOWING IT HAS BEEN DRAWN", () => {
  const problem = { value: "waiting for the first full repaint" };
  const s = new ConsoleSession({ makeFollower: () => refusingFollower(problem) });
  s.noteViewport({ columns: 160 });
  s.syncProcesses([{ id: "p1", label: "alpha" }]);
  s.handleInput(ENTER);
  s.notePaneRendered(true);                 // the frame that was drawn was the REFUSAL
  assert.equal(s.inputIsLive(), false, "input was live while a refusal was on screen");

  problem.value = "";                        // the stream recovered
  assert.equal(s.inputIsLive(), false,
    "input went live on a recovery that has not been drawn -- the screen still shows the refusal");

  // POSITIVE CONTROL: drawing a frame that shows the process is what makes it readable. Without
  // this, a gate that refused for ever would satisfy both assertions above.
  s.notePaneRendered(true);
  assert.equal(s.inputIsLive(), true, "a redrawn, recovered pane still refused input");
});

test("A STREAM THAT BREAKS AFTER A GOOD FRAME STOPS INPUT IMMEDIATELY", () => {
  // The other direction, and the reason BOTH readings are consulted. Binding readiness only to what
  // the frame showed would let input keep flowing into a stream that has since failed, because the
  // last frame drawn was fine.
  const problem = { value: "" };
  const s = new ConsoleSession({ makeFollower: () => refusingFollower(problem) });
  s.noteViewport({ columns: 160 });
  s.syncProcesses([{ id: "p1", label: "alpha" }]);
  s.handleInput(ENTER);
  s.notePaneRendered(true);
  assert.equal(s.inputIsLive(), true, "positive control: a good frame did not enable input");
  problem.value = "the daemon stopped answering";
  assert.equal(s.inputIsLive(), false, "input kept flowing after the stream failed");
});

// A THIRD TEST WAS WRITTEN HERE AND DELETED, because no mutant could kill it. It asserted that a
// FAILED draw clears the record of what the last good frame showed -- and `paneRendered` is already
// false in that state, so `inputIsLive` never reaches the record at all. A mutant that left the
// stale value behind passed. The clearing stays in the source with its reason written there; a test
// that cannot fail is worse than none, because it manufactures confidence.
