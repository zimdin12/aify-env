#!/usr/bin/env node
// That the reaper in the RUNNING daemon can actually reap.
//
// reaper.test.js proves the sweep: given a list and a probe, these three buckets. What it could not
// prove is that the thing the daemon hands it does anything — and it did not. The daemon wired
// `remove: () => {}`, a literal no-op, so the sweep classified processes correctly every thirty seconds
// and removed none of them. Decorative.
//
// That is the same shape as the 97-minute incident this whole component is built against: everything
// looked right, the cleanup simply never happened. A unit test of the sweep cannot see it, because the
// sweep was never wrong.
//
// So the wiring is a named, tested thing rather than an object literal at a call site.
//
// IT CALLS `release()`, NOT `stop()`, SINCE 2026-08-26, and these tests changed with it deliberately.
// Everything handed to the wiring has just been PROVEN DEAD -- the sweep only buckets an entry as dead
// when the liveness probe answered ESRCH. `stop()` ends by issuing `taskkill /PID <pid> /T /F`, which
// against an already-dead process can achieve nothing, and on Windows -- where pids are recycled fast
// on a host spawning agents continuously -- can land on whatever now owns that number and take its
// whole TREE. Pure downside. The last test in this file is the one that pins it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createReaper } from "../lib/reaper.mjs";
import { Runner } from "../lib/runner.mjs";

/** A stand-in runner that records BOTH verbs, so a test can tell which one the wiring used. */
function fakeRunner(processes) {
  return {
    stopped: [],
    released: [],
    list: () => processes,
    async stop(id) {
      this.stopped.push(id);
    },
    release(id) {
      this.released.push(id);
    },
  };
}

test("a dead process is RELEASED through the runner, not merely forgotten", () => {
  // release() frees the registry entry, the live handle AND the output buffer. Removing from a
  // registry alone would leave the buffer behind, which is a leak with a slow fuse.
  const runner = fakeRunner([{ id: "p1", pid: 999, service: "s" }]);
  const reaper = createReaper(runner, { isAlive: () => false });

  const swept = reaper.sweep();
  assert.deepEqual(swept.reaped, ["p1"]);
  assert.deepEqual(runner.released, ["p1"], "the reaper classified it and then did nothing");
});

test("and it does NOT kill: a pid proved dead is never tree-killed", () => {
  // THE POINT OF THE CHANGE. `stop()` would issue `taskkill /PID <pid> /T /F` at a number the sweep
  // has just proved belongs to nothing. It cannot help, and on Windows the number may since have been
  // recycled onto a live sibling whose whole tree `/T` would take.
  const runner = fakeRunner([{ id: "p1", pid: 999, service: "s" }]);
  createReaper(runner, { isAlive: () => false }).sweep();
  assert.deepEqual(
    runner.stopped, [],
    "the reaper issued a forcible tree-kill against a pid it had just established was gone",
  );
});

test("a live process is left alone", () => {
  const runner = fakeRunner([{ id: "p1", pid: process.pid, service: "s" }]);
  createReaper(runner, { isAlive: () => true }).sweep();
  assert.deepEqual(runner.stopped, []);
  assert.deepEqual(runner.released, [], "a live process was released out of the registry");
});

test("a process the probe could not judge is NOT stopped", () => {
  // Reaping on no evidence drops a live process out of the only place that knows about it, which is
  // worse than the leak. It is surfaced instead.
  const runner = fakeRunner([{ id: "p1", pid: 5, service: "s" }]);
  const swept = createReaper(runner, { isAlive: () => { throw new Error("EPERM"); } }).sweep();
  assert.deepEqual(runner.stopped, []);
  assert.deepEqual(runner.released, []);
  assert.equal(swept.unknown.length, 1);
});

test("the reaper reads the runner's CURRENT list on every sweep", () => {
  // Captured once, it would keep reaping processes that are long gone and miss every new one.
  const processes = [];
  const runner = fakeRunner(processes);
  const reaper = createReaper(runner, { isAlive: () => false });

  reaper.sweep();
  assert.deepEqual(runner.released, []);

  processes.push({ id: "later", pid: 42, service: "s" });
  reaper.sweep();
  assert.deepEqual(runner.released, ["later"], "the reaper was holding a stale list");
});

test("a release that THROWS does not break the sweep for the others", () => {
  // One wedged entry must not stop the rest of the host being cleaned up.
  const runner = {
    released: [],
    list: () => [{ id: "bad", pid: 1, service: "s" }, { id: "good", pid: 2, service: "s" }],
    release(id) {
      if (id === "bad") throw new Error("release failed");
      this.released.push(id);
    },
  };
  const swept = createReaper(runner, { isAlive: () => false }).sweep();
  assert.deepEqual(swept.reaped, ["bad", "good"]);
  assert.deepEqual(runner.released, ["good"]);
});

test("release frees what stop frees, minus the kill", () => {
  // A REAL runner, not the stand-in: the whole reason `release` exists is that it must do everything
  // `stop` does to the environment's own bookkeeping. If it forgot the buffer, this change would swap
  // a rare cross-kill for a certain slow leak.
  const runner = new Runner({ openTerminal: null });
  const spec = {
    service: "test-service",
    fileText: ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10)),
    command: process.execPath,
    args: ["-e", "process.stdout.write('x')"],
  };
  return runner.start(spec).then(async (handle) => {
    await handle.exited;
    // The registry entry goes when the process ENDS -- `finish()` removes it -- but the stream
    // deliberately OUTLIVES the process so a console attaching just after an exit still sees why it
    // exited. That surviving buffer is the thing the reaper has to let go of, and the thing a
    // "just forget the entry" fix would have leaked.
    assert.equal(runner.canStream(handle.id), true, "the buffer is not held after exit; test premise wrong");

    runner.release(handle.id);

    assert.deepEqual(runner.list(), [], "release left the registry entry behind");
    assert.equal(runner.canStream(handle.id), false, "release left the output buffer behind");
  });
});
