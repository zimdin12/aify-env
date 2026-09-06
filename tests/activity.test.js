#!/usr/bin/env node
// Which lanes are producing, from the PTY and nothing else.
//
// THE BOUNDARY IS THE POINT OF THIS FILE. aify-env may say what it OBSERVED on a terminal it owns;
// it may not say what an agent IS DOING. The second one is a service's judgement over a dispatch
// turn, a worker lease, a heartbeat and a screen model, and it already has an owner. The screen-model
// half was implemented in this repo once -- at 5am on 2026-09-03, to unblock a fleet -- and the
// operator ruled it the wrong layer; it lives in aify-comms as `console_prompts.py` now.
//
// So there is no `blocked` here, and its absence is tested rather than merely intended.

import assert from "node:assert/strict";
import { test } from "node:test";

import { activityOf, QUIET, UNKNOWN, WORKING, WORKING_SILENCE_MS } from "../lib/activity.mjs";

const NOW = 1_800_000_000_000;

test("a process that emitted just now is working", () => {
  assert.equal(activityOf({ lastOutputAtMs: NOW - 200 }, NOW), WORKING);
});

test("a process silent past the window is quiet", () => {
  assert.equal(activityOf({ lastOutputAtMs: NOW - WORKING_SILENCE_MS - 1 }, NOW), QUIET);
});

test("the boundary itself counts as working", () => {
  // Stated rather than left to fall out of an inequality: a row flipping at exactly the threshold is
  // the kind of thing that gets "fixed" in the wrong direction later.
  assert.equal(activityOf({ lastOutputAtMs: NOW - WORKING_SILENCE_MS }, NOW), WORKING);
});

test("NO EVIDENCE IS NOT QUIET: a process that has never emitted is unknown", () => {
  // A lane seconds from its first frame and a lane that has gone silent are different facts, and
  // rendering them the same way would be a claim nothing measured -- the false-green shape both of
  // these repos keep getting caught by.
  assert.equal(activityOf({}, NOW), UNKNOWN);
  assert.equal(activityOf({ lastOutputAtMs: null }, NOW), UNKNOWN);
  assert.equal(activityOf(null, NOW), UNKNOWN);
});

test("a daemon too old to report the field is unknown, not quiet", () => {
  // The upgrade path. Every process row from a pre-2026-09-06 daemon looks exactly like this, and
  // reporting a whole host as silent would be worse than reporting nothing.
  assert.equal(activityOf({ id: "p1", pid: 4, label: "sc-lead" }, NOW), UNKNOWN);
});

test("a stamp from the FUTURE is unknown rather than working", () => {
  // Clocks move, and a reader can disagree with the daemon. Treating a future stamp as activity
  // would pin a dead lane to `working` for as long as the skew lasts -- which is the one direction
  // that actively misleads: it says "this one is busy, look elsewhere".
  assert.equal(activityOf({ lastOutputAtMs: NOW + 5000 }, NOW), UNKNOWN);
});

test("an unreadable clock is unknown, and never a guess", () => {
  assert.equal(activityOf({ lastOutputAtMs: NOW }, Number.NaN), UNKNOWN);
});

test("the window is a real duration, not a placeholder", () => {
  // It is the definition of the word this module puts on screen. A zero or a negative would make
  // every row quiet the instant it stopped emitting, which is not what `working` means.
  assert.ok(WORKING_SILENCE_MS > 0);
  assert.ok(Number.isFinite(WORKING_SILENCE_MS));
});

test("the three states are distinct values", () => {
  // A renderer switches on these. Two of them collapsing to one string would make a whole state
  // invisible with nothing failing.
  assert.equal(new Set([WORKING, QUIET, UNKNOWN]).size, 3);
});

test("THIS TIER HAS NO OPINION ABOUT BLOCKED", () => {
  // The boundary, asserted rather than intended. Adding a `blocked` here means knowing what a
  // claude confirmation dialog looks like, which is the knowledge the operator moved OUT of this
  // repo. A future export named for it should fail this and be argued for, not slipped in.
  const states = new Set([WORKING, QUIET, UNKNOWN]);
  assert.ok(!states.has("blocked"), "a screen-derived state reached the environment tier");
});
