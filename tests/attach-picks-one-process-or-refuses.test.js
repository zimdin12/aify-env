// Which process `aify-env attach sc-lead` means, and what it does when the answer is not one.
//
// THE HEADLINE THIS SERVES. v0.6.2's first item is hosting a resident's PTY here so a closed terminal
// stops killing an agent, and so the same terminal can be watched from somewhere else. Both need a
// client that ATTACHES to a real terminal rather than redrawing one, and attaching starts with
// choosing what to attach to.
//
// AN OPERATOR THINKS IN AGENT NAMES, not in `f07a10b2-...-p1`. Requiring the id would make the
// command unusable for the case it exists for: looking at a lane that is misbehaving, right now,
// without first running a second command to find its handle.
//
// AND AN AMBIGUOUS NAME IS THE ONE THAT MUST NOT BE GUESSED. Two processes can carry one label -- a
// restart that overlapped, or one host running the same agent for two services. Attaching is the
// only part of this repo's console surface that WRITES: every key typed goes to whichever process
// was picked. Guessing there types an operator's words into a session they did not choose, and the
// cost of refusing is one more word from them.
//
// PURE, so every case is decided without a daemon, a socket or a terminal. The failing paths are the
// ones that only happen when something is already wrong, which is exactly when they must be right.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAttachTarget } from "../lib/attach-target.mjs";

const LEAD = { id: "inst-p1", label: "sc-lead", pid: 1 };
const TESTER = { id: "inst-p2", label: "sc-tester", pid: 2 };
const RUNNING = [LEAD, TESTER];

test("an agent name resolves to its process", () => {
  assert.deepEqual(resolveAttachTarget(RUNNING, "sc-lead"), { id: "inst-p1" });
});

test("an id resolves too, because that is what a script would pass", () => {
  assert.deepEqual(resolveAttachTarget(RUNNING, "inst-p2"), { id: "inst-p2" });
});

test("AN ID WINS OVER A LABEL, so an exact handle is never ambiguous", () => {
  // A host where somebody labelled one process with another's id is pathological, but the resolution
  // order has to be decidable anyway: the id is unique by construction and the label is not.
  const odd = [{ id: "inst-p1", label: "x" }, { id: "inst-p9", label: "inst-p1" }];
  assert.deepEqual(resolveAttachTarget(odd, "inst-p1"), { id: "inst-p1" });
});

test("A DUPLICATE LABEL IS REFUSED AND THE IDS ARE NAMED", () => {
  // THE ONE THAT MATTERS. Picking either would send the operator's keystrokes into a session they
  // did not choose. Refusing is useless without the ids, though -- a refusal a person cannot act on
  // is a stall, which is why the fix line carries them.
  const twins = [LEAD, { id: "inst-p7", label: "sc-lead", pid: 7 }];
  const answer = resolveAttachTarget(twins, "sc-lead");
  assert.ok(answer.error, "an ambiguous name was resolved to one process");
  assert.match(answer.error, /2 processes/);
  assert.match(answer.fix, /inst-p1/);
  assert.match(answer.fix, /inst-p7/);
});

test("case does not decide it", () => {
  // Agent ids are lowercase by convention and an operator typing `SC-Lead` means the same lane.
  assert.deepEqual(resolveAttachTarget(RUNNING, "SC-LEAD"), { id: "inst-p1" });
});

test("an unknown name NAMES WHAT IS RUNNING", () => {
  // The likeliest reason to get this wrong is a typo or a stale memory of what is up, and both are
  // answered by the list. A bare "not found" makes the operator run a second command.
  const answer = resolveAttachTarget(RUNNING, "sc-nobody");
  assert.match(answer.error, /sc-nobody/);
  assert.match(answer.error, /sc-lead/);
  assert.match(answer.error, /sc-tester/);
});

test("NO NAME AT ALL is answered with the candidates, not with usage", () => {
  // Someone who does not know what is running is most of the reason to reach for this command.
  const answer = resolveAttachTarget(RUNNING, "");
  assert.match(answer.error, /sc-lead, sc-tester/);
});

test("an empty host says so rather than listing nothing", () => {
  // "Running: " with nothing after it reads as a broken tool. Two different facts, two sentences.
  assert.match(resolveAttachTarget([], "").error, /running nothing/);
  assert.match(resolveAttachTarget([], "sc-lead").error, /running nothing/);
});

test("junk in the list cannot become a target", () => {
  // NEGATIVE CONTROLS. A malformed process entry must not resolve, or a garbled listing hands the
  // keyboard to something with no id at all.
  for (const junk of [undefined, null, "sc-lead", 3, {}, { id: "" }, { label: "sc-lead" }]) {
    const answer = resolveAttachTarget([junk], "sc-lead");
    assert.ok(answer.error, `${JSON.stringify(junk)} resolved to a target`);
  }
});

test("a list that is not a list is refused, not iterated", () => {
  for (const junk of [undefined, null, "two", 3, {}]) {
    assert.ok(resolveAttachTarget(junk, "sc-lead").error);
  }
});

test("whitespace is not a name", () => {
  // `attach "  "` is a typo, not a request for a process called two spaces, and trimming to empty
  // must take the "which one did you mean" path rather than searching for it.
  assert.match(resolveAttachTarget(RUNNING, "   ").error, /needs an agent/);
});
