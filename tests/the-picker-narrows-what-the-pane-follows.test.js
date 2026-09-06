#!/usr/bin/env node
// The picker filters the list AND the pane follows it, which are two halves of one feature.
//
// `keys.mjs` knows only an index and a count -- it has no idea what a process is, which is what keeps
// the key layer free of any service's concepts. `ConsoleSession` is where the query becomes a
// narrowed list, so the seam between "the operator typed sc-c" and "the pane is streaming sc-coder"
// lives here and nowhere else.
//
// THE WORST WAY FOR THIS TO BE WRONG is one agent's NAME over another agent's OUTPUT. Typing narrows
// the list without the selection index changing, so a session that filtered but did not re-derive
// the follower would leave the pane streaming whatever was under the old index -- and the header
// would say the newly-selected agent's name. An operator would then type into the wrong lane.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { DETACH } from "../lib/keys.mjs";

const ENTER = "\r";

/** Records which process each follower was built for, so the pane's target is observable. */
function session(rows) {
  const built = [];
  const s = new ConsoleSession({
    endpoint: "http://127.0.0.1:8802",
    makeFollower: (id) => {
      built.push(id);
      return { start: () => {}, stop: () => {}, status: "open", exit: null, lines: () => [] };
    },
  });
  s.syncProcesses(rows);
  return { s, built };
}

const FLEET = [
  { id: "p1", label: "sc-lead", title: "Claude Code" },
  { id: "p2", label: "sc-coder", title: "Claude Code" },
  { id: "p3", label: "sc-critic", title: "Claude Code" },
  { id: "p4", label: "mc-manager", title: "hermes" },
];

const type = (s, text) => { for (const ch of text) s.handleInput(ch); };

test("POSITIVE CONTROL: with no query every process is visible", () => {
  // Each assertion below is "the list narrowed". A `visible()` returning nothing would satisfy most
  // of them for the wrong reason, and this is what separates the two.
  const { s } = session(FLEET);
  assert.equal(s.visible().length, 4);
  assert.equal(s.selected.id, "p1");
});

test("typing in the picker narrows the list", () => {
  const { s } = session(FLEET);
  s.handleInput("g");
  type(s, "sc-c");
  assert.deepEqual(s.visible().map((row) => row.label), ["sc-coder", "sc-critic"]);
});

test("THE PANE FOLLOWS THE FILTER, not the old index", () => {
  // The defect this file exists for. The selection stays at index 0 the whole time; what index 0
  // MEANS changes with every keystroke, and the follower has to be re-derived from the list rather
  // than from an assumption that the cursor moved.
  const { s, built } = session(FLEET);
  assert.equal(built.at(-1), "p1");
  s.handleInput("g");
  type(s, "sc-crit");
  assert.equal(s.selected.label, "sc-critic");
  assert.equal(built.at(-1), "p3", "the pane is still streaming the process that used to be first");
});

test("the match reads label, title and id — everything on screen", () => {
  // Matching a field the list does not show would make a row appear for no visible reason.
  const byTitle = session(FLEET);
  byTitle.s.handleInput("g");
  type(byTitle.s, "hermes");
  assert.deepEqual(byTitle.s.visible().map((r) => r.label), ["mc-manager"]);

  const byId = session(FLEET);
  byId.s.handleInput("g");
  type(byId.s, "p4");
  assert.deepEqual(byId.s.visible().map((r) => r.label), ["mc-manager"]);
});

test("matching is case-insensitive, because nobody types an agent id in caps", () => {
  const { s } = session(FLEET);
  s.handleInput("g");
  type(s, "SC-LEAD");
  assert.deepEqual(s.visible().map((r) => r.label), ["sc-lead"]);
});

test("a query matching NOTHING selects nothing, and the pane lets go", () => {
  // It must not keep streaming the last match: the operator is looking at an empty list, and a pane
  // full of output would say a process is selected when none is.
  const { s } = session(FLEET);
  s.handleInput("g");
  type(s, "zzzz");
  assert.equal(s.visible().length, 0);
  assert.equal(s.selected, null);
  assert.equal(s.pane(), null);
});

test("accepting keeps the chosen process and restores the whole list", () => {
  const { s, built } = session(FLEET);
  s.handleInput("g");
  type(s, "critic");
  s.handleInput(ENTER);
  assert.equal(s.focus.mode, "dashboard");
  assert.equal(s.visible().length, 4, "the filter outlived its own picker");
  assert.equal(s.selected.label, "sc-critic", "the chosen agent was lost on the way out");
  assert.equal(built.at(-1), "p3");
});

test("Ctrl+] abandons the search and goes back to where it started", () => {
  // ABANDONING MUST NOT MOVE THE SELECTION. Accepting means "this one"; cancelling means "never
  // mind", and landing somewhere new is the one thing it must not do.
  const { s, built } = session(FLEET);
  s.handleInput("2");
  assert.equal(s.selected.label, "sc-coder");
  s.handleInput("g");
  type(s, "critic");
  assert.equal(s.selected.label, "sc-critic", "the filter did not take");
  s.handleInput(DETACH);
  assert.equal(s.focus.mode, "dashboard");
  assert.equal(s.visible().length, 4);
  assert.equal(s.selected.label, "sc-coder", "cancelling the picker moved the selection");
  assert.equal(built.at(-1), "p2", "the pane did not follow the selection back");
});

test("a digit jumps within the WHOLE list when no picker is open", () => {
  const { s, built } = session(FLEET);
  s.handleInput("3");
  assert.equal(s.selected.label, "sc-critic");
  assert.equal(built.at(-1), "p3");
});

test("a process exiting under a filter clamps the selection into the narrowed list", () => {
  // Processes come and go while the picker is open -- that is the normal case here, since watching
  // work start and finish is the point of the view. Reconciling against the WHOLE list would leave
  // the cursor past the end of what is shown and point the pane at something invisible.
  const { s } = session(FLEET);
  s.handleInput("g");
  type(s, "sc-c");
  s.handleInput(String.fromCharCode(27) + "[B");   // down: sc-critic, index 1 of 2
  assert.equal(s.selected.label, "sc-critic");
  s.syncProcesses(FLEET.filter((row) => row.id !== "p3"));
  assert.equal(s.visible().length, 1);
  assert.equal(s.selected.label, "sc-coder", "the selection sat past the end of the narrowed list");
});
