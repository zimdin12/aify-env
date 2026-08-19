#!/usr/bin/env node
// passed / failed / UNANSWERED, and why the third one has to exist.
//
// The verifier this replaces has two states and a skip, and the skip pushes ok:true. On Windows two of
// its twelve checks read /proc and skip, so a green --strict run there means ten verified and two
// unanswerable — which is survivable at twelve checks on one host and stops being survivable across
// four components, where "not installed" and "silent" become the ordinary cases rather than the odd
// ones.
//
// So unanswered is a first-class state with its own exit status. A check that could not gather
// evidence has not passed. That rule has already been paid for twice here: a health check once
// reported "2 connected" with zero bridges alive, and another was green-by-default whenever nothing
// reported at all.

import assert from "node:assert/strict";
import { test } from "node:test";

import { passed, failed, unanswered, summarise, EXIT } from "../lib/health.mjs";

test("a check carries its state, its id, and a detail a human can act on", () => {
  const check = failed("env-bridge", "no environment is online", "Start one with: aify-env");
  assert.equal(check.id, "env-bridge");
  assert.equal(check.state, "failed");
  assert.ok(check.detail.length > 0);
  assert.ok(check.fix.length > 0, "a failure without a remedy is a complaint");
});

test("all passed is exit 0", () => {
  const result = summarise([passed("a", "fine"), passed("b", "fine")]);
  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(result.counts.passed, 2);
});

test("any failure is exit 1, even beside passes", () => {
  const result = summarise([passed("a", "fine"), failed("b", "broken", "fix it")]);
  assert.equal(result.exitCode, EXIT.FAILED);
});

test("UNANSWERED is not a pass, and gets its own exit status", () => {
  // The whole point. If unanswered exited 0, a silent service would read exactly like a healthy one.
  const result = summarise([passed("a", "fine"), unanswered("b", "service did not respond")]);
  assert.notEqual(result.exitCode, EXIT.OK, "unanswered must not exit 0");
  assert.equal(result.exitCode, EXIT.UNANSWERED);
  assert.equal(result.counts.unanswered, 1);
});

test("a real failure outranks an unanswered one", () => {
  // A reader fixing one thing should be pointed at the thing that is known broken.
  const result = summarise([unanswered("a", "silent"), failed("b", "broken", "fix it")]);
  assert.equal(result.exitCode, EXIT.FAILED);
});

test("NO CHECKS AT ALL is unanswered, never ok", () => {
  // A verifier that gathered nothing has verified nothing. Reporting that as healthy is the exact
  // false green this file exists to prevent.
  const result = summarise([]);
  assert.notEqual(result.exitCode, EXIT.OK);
  assert.equal(result.counts.unanswered, 0);
  assert.match(result.summary, /no checks/i);
});

test("the summary NAMES what failed and what went unanswered", () => {
  // A count alone sends the reader to a log. The ids are what turn the result into a next action.
  const result = summarise([
    passed("wrappers", "4 installed"),
    failed("env-bridge", "nothing online", "start one"),
    unanswered("aify-comms", "no response"),
  ]);
  assert.match(result.summary, /env-bridge/);
  assert.match(result.summary, /aify-comms/);
});

test("unanswered cannot be constructed with a blank reason", () => {
  // "Unanswered" with no reason is indistinguishable from a bug in the checker, and a reader cannot
  // tell whether to chase the service or the tool.
  assert.throws(() => unanswered("a", ""), /reason/i);
  assert.throws(() => unanswered("a"), /reason/i);
});

test("failed cannot be constructed without a fix", () => {
  assert.throws(() => failed("a", "broken", ""), /fix/i);
});

test("the JSON shape carries the three states distinctly", () => {
  const result = summarise([passed("a", "x"), failed("b", "y", "z"), unanswered("c", "w")]);
  const states = result.checks.map((check) => check.state).sort();
  assert.deepEqual(states, ["failed", "passed", "unanswered"]);
  // Not a boolean anywhere: a two-valued field is how the third state gets collapsed back into a pass.
  assert.equal(result.checks.some((check) => typeof check.ok === "boolean"), false);
});
