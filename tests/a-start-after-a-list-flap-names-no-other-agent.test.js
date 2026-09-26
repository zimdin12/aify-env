// Starting an agent after a list flap reports that start and nothing about another agent.
//
// THE DEFECT (v0.7.1 review, E1). The operator opens `m` on alpha. One poll gets no answer, so the
// process list is empty for a frame and `reconcileFocus` closes the menu -- but the subject the menu
// had bound, `actionTargetId`, stayed set. Alpha is back on the next poll. The operator then starts
// bravo with `s` and Enter, and the result carried BOTH `startAgent: bravo` and
// `perform: {action: "start", process: alpha}`. `aify-env tui` hands every `perform` to the daemon
// and reports the answer, so NOTICES said "start of alpha failed" beside "starting bravo".
//
// A menu's subject belongs to the menu. Once the focus is in neither the menu nor its confirmation,
// nothing may still be bound.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const ALPHA = { id: "p-alpha", label: "alpha" };

function session() {
  const s = new ConsoleSession({
    makeFollower: () => ({ status: "connecting", start: async () => {}, stop() {}, lines: () => [] }),
    actions: ["attach", "stop"],
  });
  s.noteViewport({ columns: 120 });
  s.syncProcesses([ALPHA]);
  return s;
}

/** `s`, an answer naming bravo, then Enter. */
function startBravo(s) {
  s.handleInput("s");
  s.noteStartable([{ id: "bravo", name: "bravo" }]);
  return s.handleInput(ENTER);
}

test("a start chosen after the menu was closed by an empty poll performs nothing on alpha", () => {
  const s = session();
  s.handleInput("m");
  assert.equal(s.actionTargetId, ALPHA.id, "positive control: the menu did not bind alpha");
  s.syncProcesses([]);                 // one poll with no answer
  assert.equal(s.focus.mode, "dashboard", "positive control: the empty list did not close the menu");
  s.syncProcesses([ALPHA]);            // alpha is back
  const result = startBravo(s);
  assert.equal(result.startAgent?.id, "bravo", "the start itself was lost");
  assert.equal(result.perform, null,
    `a start of bravo also asked the caller to act on ${JSON.stringify(result.perform)}`);
});

test("CONTROL: with no flap, the same start performs nothing either", () => {
  const result = startBravo(session());
  assert.equal(result.startAgent?.id, "bravo");
  assert.equal(result.perform, null);
});

test("CONTROL: a stop confirmed in an open menu still names its process", () => {
  const s = session();
  s.handleInput("m");
  s.handleInput(DOWN);                 // attach -> stop
  s.handleInput(ENTER);                // asks
  const result = s.handleInput("y");
  assert.deepEqual(result.perform, { action: "stop", process: ALPHA });
});
