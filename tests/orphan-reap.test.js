#!/usr/bin/env node
// Killing what a DEAD instance left behind.
//
// The operator's requirement: if aify-env dies, the processes it manages die with it. A shutdown
// handler covers the graceful paths and misses the one that matters -- a hard kill runs no handler --
// so the durable half is this: the next instance reads the record and reaps whatever is still alive.
//
// PID REUSE IS THE HAZARD, and it is named rather than ignored. A pid recorded before a crash can
// belong to something unrelated by the time we read it, and killing that would be far worse than the
// leak we are fixing. `verify` is the guard, and it is injectable because how you confirm a process's
// identity is platform work that should not be welded into the decision.
//
// The decision is a PURE function of what it was told, so every branch is testable without killing
// anything on the machine running the tests.

import assert from "node:assert/strict";
import { test } from "node:test";

//: A FIXED START INSTANT for the tests below, which are about the COMMAND LINE.
//: `defaultVerify` also requires the process's real start time to match the one the record
//: holds -- the half that stops a pid recycled onto a SIBLING agent from verifying, since
//: every Claude agent on a host shares one launcher path. These tests supply an agreeing
//: pair so they keep asking their own question; the start-time rule has its own tests.
const RECORDED_AT = Date.parse("2026-09-04T09:00:00.000Z");

import { planOrphanReap } from "../lib/orphan-reap.mjs";

const entry = (over = {}) => ({ id: "p1", pid: 4242, service: "aify-comms", startedAt: 1000, ...over });

test("a recorded process that is still alive is reaped", () => {
  const plan = planOrphanReap([entry()], { isAlive: () => true, verify: () => true });
  assert.deepEqual(plan.reap.map((e) => e.pid), [4242]);
  assert.deepEqual(plan.skipped, []);
});

test("a recorded process that is already gone is not reaped, and not an error", () => {
  const plan = planOrphanReap([entry()], { isAlive: () => false, verify: () => true });
  assert.deepEqual(plan.reap, []);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["already gone"]);
});

test("a pid that VERIFY rejects is skipped — this is the pid-reuse guard", () => {
  // The case that matters: the pid is alive, but it is no longer our process. Killing it would end
  // something unrelated, which is a worse failure than the leak.
  const plan = planOrphanReap([entry()], { isAlive: () => true, verify: () => false });
  assert.deepEqual(plan.reap, []);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["not ours any more"]);
});

test("each entry is judged on its own", () => {
  const plan = planOrphanReap(
    [entry({ id: "a", pid: 1 }), entry({ id: "b", pid: 2 }), entry({ id: "c", pid: 3 })],
    { isAlive: (pid) => pid !== 2, verify: (e) => e.pid !== 3 },
  );
  assert.deepEqual(plan.reap.map((e) => e.pid), [1]);
  assert.deepEqual(plan.skipped.map((s) => [s.entry.pid, s.reason]), [[2, "already gone"], [3, "not ours any more"]]);
});

test("an empty record plans nothing", () => {
  const plan = planOrphanReap([], { isAlive: () => true, verify: () => true });
  assert.deepEqual(plan.reap, []);
  assert.deepEqual(plan.skipped, []);
});

test("a verify that THROWS is treated as a rejection, not as permission", () => {
  // Fail closed on the killing decision. If we cannot establish that the process is ours, we do not
  // end it -- the leak is recoverable and killing a stranger's process is not.
  const plan = planOrphanReap([entry()], { isAlive: () => true, verify: () => { throw new Error("no idea"); } });
  assert.deepEqual(plan.reap, []);
  assert.equal(plan.skipped[0].reason, "not ours any more");
});

test("an isAlive that throws is treated as gone, not as alive", () => {
  const plan = planOrphanReap([entry()], { isAlive: () => { throw new Error("EPERM?"); }, verify: () => true });
  assert.deepEqual(plan.reap, []);
  assert.equal(plan.skipped[0].reason, "already gone");
});

// The identity probe itself. Injected platform and runner, so every branch is decidable without
// killing anything or depending on what happens to be running on the test machine.

import { defaultVerify } from "../lib/orphan-reap.mjs";

test("a record with no launcher is never confirmed — there is nothing to match", () => {
  // Records written before launchers were tracked. We genuinely cannot tell, so we do not kill.
  assert.equal(defaultVerify({ pid: 1, launcher: "", startedAt: RECORDED_AT }, { platform: "win32", run: () => ({ stdout: "anything", startedAtOf: () => RECORDED_AT }) }), false);
});

test("windows: a command line containing the launcher confirms it", () => {
  // Backslashes built rather than typed: a literal one in a shell heredoc does not survive, and
  // a silently de-escaped string made this test pass for the wrong reason once already.
  const BS = String.fromCharCode(92);
  const run = () => ({ stdout: `C:${BS}Windows${BS}system32${BS}cmd.exe /c "C:${BS}launchers${BS}claude-aify"` });
  assert.equal(defaultVerify({ pid: 1, launcher: "C:/launchers/claude-aify", startedAt: RECORDED_AT }, { platform: "win32", run, startedAtOf: () => RECORDED_AT }), true);
});

test("windows: a DIFFERENT command line is refused — the pid was recycled", () => {
  const run = () => ({ stdout: "C:\Windows\explorer.exe" });
  assert.equal(defaultVerify({ pid: 1, launcher: "C:/launchers/claude-aify", startedAt: RECORDED_AT }, { platform: "win32", run, startedAtOf: () => RECORDED_AT }), false);
});

test("an empty command line is refused rather than treated as a match", () => {
  assert.equal(defaultVerify({ pid: 1, launcher: "/l/x", startedAt: RECORDED_AT }, { platform: "win32", run: () => ({ stdout: "   ", startedAtOf: () => RECORDED_AT }) }), false);
});

test("a probe that throws is refused", () => {
  const run = () => { throw new Error("access denied"); };
  assert.equal(defaultVerify({ pid: 1, launcher: "/l/x", startedAt: RECORDED_AT }, { platform: "win32", run, startedAtOf: () => RECORDED_AT }), false);
});

test("an unsupported platform confirms nothing, so nothing is killed there", () => {
  assert.equal(defaultVerify({ pid: 1, launcher: "/l/x", startedAt: RECORDED_AT }, { platform: "darwin", run: () => ({ stdout: "/l/x", startedAtOf: () => RECORDED_AT }) }), false);
});
