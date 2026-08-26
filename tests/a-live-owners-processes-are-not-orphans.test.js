#!/usr/bin/env node
// A record entry whose OWNER is still running is not an orphan.
//
// THE INCIDENT, 2026-08-26, reproduced three times in one evening with a two-second watcher on the
// live host. An aify-comms test started this daemon with `--port 0` and no `AIFY_ENV_PROCESS_RECORD`,
// so the record defaulted to `~/.aify/env-processes.json` -- the RUNNING instance's record. The new
// daemon read it, found every process alive and verifiably "ours", killed each tree, and cleared the
// file. Each time, a pair of the operator's managed workers died three seconds apart, and the shared
// record's mtime matched the minute of the deaths.
//
// WHY THE EXISTING GUARD DID NOT HOLD. `bin/aify-env.mjs` reaps only once it HOLDS THE PORT, on the
// reasoning that holding it proves nobody else is serving -- and that reasoning is written into the
// file, along with the earlier incident it came from. It is correct for a second start on the SAME
// port. It says nothing about `--port 0`, where the OS hands out an ephemeral port that is always
// free: the guard passes instantly for an instance that owns nothing at all.
//
// So the port is the wrong thing to ask. The right question is who wrote the entry, and whether that
// instance is still alive -- which is what the record now carries and this file pins.

import assert from "node:assert/strict";
import { test } from "node:test";

import { planOrphanReap } from "../lib/orphan-reap.mjs";

const entry = (over = {}) => ({ id: "p1", pid: 4242, service: "aify-comms", startedAt: 1000, ...over });
const alwaysOurs = { isAlive: () => true, verify: () => true };

test("an entry whose owner is still running is skipped, and the reason names the owner", () => {
  const plan = planOrphanReap([entry({ owner: 99 })], { ...alwaysOurs, ownerIsAlive: () => true });
  assert.deepEqual(plan.reap, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /owner \(pid 99\) is still running/);
});

test("an entry whose owner has DIED is reaped -- that is the whole point of the record", () => {
  // The guard must not turn into "never reap". A crashed instance's leftovers are exactly what this
  // mechanism exists for, and the operator's rule is that they die with the environment.
  const plan = planOrphanReap([entry({ owner: 99 })], { ...alwaysOurs, ownerIsAlive: () => false });
  assert.deepEqual(plan.reap.map((e) => e.pid), [4242]);
});

test("an entry with NO owner keeps the old behaviour", () => {
  // Deliberately not fail-closed. An entry written before the field existed is precisely the crash
  // leftover the reaper is for; refusing to touch it would disable recovery for the case that matters.
  const plan = planOrphanReap([entry()], { ...alwaysOurs, ownerIsAlive: () => true });
  assert.deepEqual(plan.reap.map((e) => e.pid), [4242]);
});

test("a nonsense owner is treated as no owner, not as a live one", () => {
  for (const owner of [0, -1, "", "abc", null, undefined, 1.5, Number.NaN]) {
    const plan = planOrphanReap([entry({ owner })], { ...alwaysOurs, ownerIsAlive: () => true });
    assert.deepEqual(plan.reap.map((e) => e.pid), [4242], `owner ${JSON.stringify(owner)} blocked the reap`);
  }
});

test("an owner probe that THROWS leaves the process alone", () => {
  // Unanswerable is not evidence the owner is gone, and it is being gone that licenses the kill. The
  // opposite reading would make an unreliable probe into permission -- which is how the whole class of
  // fail-open guard goes wrong.
  const plan = planOrphanReap([entry({ owner: 99 })], {
    ...alwaysOurs,
    ownerIsAlive: () => { throw new Error("cannot probe"); },
  });
  assert.deepEqual(plan.reap, []);
  assert.match(plan.skipped[0].reason, /still running/);
});

test("the owner check runs AFTER the already-gone check, so a dead process is not reported as somebody's", () => {
  // Ordering matters for the message an operator reads. A process that has already exited is "already
  // gone" whoever owned it; calling it "its owner is still running" would send them looking for a
  // process that is not there.
  const plan = planOrphanReap([entry({ owner: 99 })], {
    isAlive: () => false, verify: () => true, ownerIsAlive: () => true,
  });
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["already gone"]);
});

test("the owner check runs BEFORE verify, so a live owner's process is never even identity-probed", () => {
  // `verify` shells out on win32. Skipping earlier is both cheaper and safer: an entry we will not
  // touch should not be inspected at all.
  let verified = 0;
  const plan = planOrphanReap([entry({ owner: 99 })], {
    isAlive: () => true,
    verify: () => { verified += 1; return true; },
    ownerIsAlive: () => true,
  });
  assert.deepEqual(plan.reap, []);
  assert.equal(verified, 0, "a live owner's entry was handed to the identity probe anyway");
});

test("ownerIsAlive defaults to isAlive -- it is the same question about a different pid", () => {
  // Every existing caller passes only `isAlive`, and the guard has to hold for them too.
  const asked = [];
  const plan = planOrphanReap([entry({ owner: 99 })], {
    isAlive: (pid) => { asked.push(pid); return true; },
    verify: () => true,
  });
  assert.deepEqual(plan.reap, [], "without an explicit ownerIsAlive the guard did not apply");
  assert.ok(asked.includes(99), "the owner pid was never probed");
});

test("entries are judged one at a time -- a live owner's does not protect a dead owner's", () => {
  const plan = planOrphanReap(
    [entry({ id: "live", pid: 1, owner: 99 }), entry({ id: "dead", pid: 2, owner: 100 })],
    { ...alwaysOurs, ownerIsAlive: (pid) => pid === 99 },
  );
  assert.deepEqual(plan.reap.map((e) => e.id), ["dead"]);
  assert.deepEqual(plan.skipped.map((s) => s.entry.id), ["live"]);
});
