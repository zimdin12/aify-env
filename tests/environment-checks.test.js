#!/usr/bin/env node
// The checks aify-env makes about ITSELF.
//
// Each component answers only questions about itself. These are aify-env's: can it open a terminal,
// can it read the registry, and does it still know what it owns. Nothing here inspects another
// component — that is services.mjs, and it asks.

import assert from "node:assert/strict";
import { test } from "node:test";

import { terminalCheck, registryCheck, ownedProcessesCheck } from "../lib/environment-checks.mjs";
import { STATE } from "../lib/health.mjs";

test("a host with a terminal passes", () => {
  assert.equal(terminalCheck({ available: true, reason: "" }).state, STATE.PASSED);
});

test("a host WITHOUT a terminal FAILS, and says what stops working", () => {
  // Not unanswered: we know the answer and it is no. And it must not read as a shrug, because a
  // terminal is what a web console needs to render a TUI at all — this is a real capability loss, not
  // an inconvenience.
  const check = terminalCheck({ available: false, reason: "node-pty did not load: MODULE_NOT_FOUND" });
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.detail, /MODULE_NOT_FOUND/);
  assert.ok(check.fix.length > 0);
});

test("a readable registry passes, naming how many services it found", () => {
  const check = registryCheck({ text: '{"version":1,"services":{"a":{"endpoint":"http://x"}}}' });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /1/);
});

test("an ABSENT registry passes: a host with no service is a legitimate host", () => {
  // The distinction that matters. Absent is not broken, and reporting it as a failure would make every
  // fresh install look damaged.
  const check = registryCheck({ text: null, missing: true });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /no services/i);
});

test("an UNREADABLE registry FAILS, because we know it is wrong", () => {
  const check = registryCheck({ text: "{not json" });
  assert.equal(check.state, STATE.FAILED);
  assert.ok(check.fix.length > 0);
});

test("a registry we could not READ AT ALL is unanswered, not failed", () => {
  // A permissions error is not the same as a corrupt file: one says the file is bad, the other says we
  // never saw it. Different remedies, so different states.
  const check = registryCheck({ readError: "EACCES" });
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /EACCES/);
});

test("owned processes pass with a count", () => {
  const check = ownedProcessesCheck({ owned: [{ id: "p1" }, { id: "p2" }], unknown: [] });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /2/);
});

test("owning nothing is a pass, not a problem", () => {
  assert.equal(ownedProcessesCheck({ owned: [], unknown: [] }).state, STATE.PASSED);
});

test("processes the reaper could not judge make this UNANSWERED", () => {
  // The reaper keeps what it cannot judge rather than reaping it, and the count has to surface
  // somewhere or that decision quietly becomes a leak nobody sees.
  const check = ownedProcessesCheck({ owned: [{ id: "p1" }], unknown: [{ id: "p1", pid: 5 }] });
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /p1|5/);
});
