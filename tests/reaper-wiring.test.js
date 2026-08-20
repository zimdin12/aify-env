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

import assert from "node:assert/strict";
import { test } from "node:test";

import { createReaper } from "../lib/reaper.mjs";

/** A stand-in runner that records what it was asked to stop. */
function fakeRunner(processes) {
  return {
    stopped: [],
    list: () => processes,
    async stop(id) {
      this.stopped.push(id);
    },
  };
}

test("a dead process is STOPPED through the runner, not merely forgotten", () => {
  // stop() is the right verb: it releases the registry entry, the live handle AND the output buffer.
  // Removing from a registry alone would leave the buffer behind, which is a leak with a slow fuse.
  const runner = fakeRunner([{ id: "p1", pid: 999, service: "s" }]);
  const reaper = createReaper(runner, { isAlive: () => false });

  const swept = reaper.sweep();
  assert.deepEqual(swept.reaped, ["p1"]);
  assert.deepEqual(runner.stopped, ["p1"], "the reaper classified it and then did nothing");
});

test("a live process is left alone", () => {
  const runner = fakeRunner([{ id: "p1", pid: process.pid, service: "s" }]);
  createReaper(runner, { isAlive: () => true }).sweep();
  assert.deepEqual(runner.stopped, []);
});

test("a process the probe could not judge is NOT stopped", () => {
  // Reaping on no evidence drops a live process out of the only place that knows about it, which is
  // worse than the leak. It is surfaced instead.
  const runner = fakeRunner([{ id: "p1", pid: 5, service: "s" }]);
  const swept = createReaper(runner, { isAlive: () => { throw new Error("EPERM"); } }).sweep();
  assert.deepEqual(runner.stopped, []);
  assert.equal(swept.unknown.length, 1);
});

test("the reaper reads the runner's CURRENT list on every sweep", () => {
  // Captured once, it would keep reaping processes that are long gone and miss every new one.
  const processes = [];
  const runner = {
    stopped: [],
    list: () => processes,
    async stop(id) { this.stopped.push(id); },
  };
  const reaper = createReaper(runner, { isAlive: () => false });

  reaper.sweep();
  assert.deepEqual(runner.stopped, []);

  processes.push({ id: "later", pid: 42, service: "s" });
  reaper.sweep();
  assert.deepEqual(runner.stopped, ["later"], "the reaper was holding a stale list");
});

test("a stop that REJECTS does not break the sweep for the others", () => {
  // One wedged process must not stop the rest of the host being cleaned up.
  const runner = {
    stopped: [],
    list: () => [{ id: "bad", pid: 1, service: "s" }, { id: "good", pid: 2, service: "s" }],
    async stop(id) {
      if (id === "bad") throw new Error("stop failed");
      this.stopped.push(id);
    },
  };
  const swept = createReaper(runner, { isAlive: () => false }).sweep();
  assert.deepEqual(swept.reaped, ["bad", "good"]);
  assert.deepEqual(runner.stopped, ["good"]);
});
