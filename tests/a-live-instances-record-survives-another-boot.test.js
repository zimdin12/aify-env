#!/usr/bin/env node
// Sparing another instance's process and then forgetting it is barely better than killing it.
//
// THE GAP THIS CLOSES, found by re-reading the fix that created it. The orphan reaper now declines to
// KILL an entry whose owner is still running -- and then `clearOwned` emptied the whole file anyway.
// So a second daemon left the live environment's workers alive while deleting the only record that
// they exist. They survive exactly until that environment is hard-killed, at which point nothing can
// name them: the unreapable orphan this record was built to prevent.
//
// The two mutations of the record are BOOT and SHUTDOWN, and both emptied it. The rule is the same at
// each: forget what is ours, keep what belongs to a different instance that is still running.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { clearOwned, entriesOwnedElsewhere, readOwned, recordStarted } from "../lib/owned-processes.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-keep-")), "owned.json");
const SELF = 4242;
const OTHER = 9999;

test("an entry owned by a different LIVE instance is kept", () => {
  const kept = entriesOwnedElsewhere(
    [{ id: "p1", pid: 1, owner: OTHER }],
    { ownerIsAlive: () => true, self: SELF },
  );
  assert.deepEqual(kept.map((e) => e.id), ["p1"]);
});

test("an entry owned by a different DEAD instance is not kept -- that is a leftover to clean up", () => {
  const kept = entriesOwnedElsewhere(
    [{ id: "p1", pid: 1, owner: OTHER }],
    { ownerIsAlive: () => false, self: SELF },
  );
  assert.deepEqual(kept, []);
});

test("our OWN entries are not kept, however alive we are", () => {
  // Forgetting ours is the whole point of both call sites: at boot they were reaped, at shutdown they
  // were stopped. Keeping them would leave the next instance chasing processes that are gone.
  const kept = entriesOwnedElsewhere(
    [{ id: "p1", pid: 1, owner: SELF }],
    { ownerIsAlive: () => true, self: SELF },
  );
  assert.deepEqual(kept, []);
});

test("an entry with no owner is not somebody else's", () => {
  // An entry written before the field existed is exactly the crash leftover the reaper is for.
  // Protecting it would disable recovery for the case that matters.
  for (const owner of [undefined, null, 0, -1, "", "abc", Number.NaN]) {
    const kept = entriesOwnedElsewhere([{ id: "p1", pid: 1, owner }], { ownerIsAlive: () => true, self: SELF });
    assert.deepEqual(kept, [], `owner ${JSON.stringify(owner)} was treated as another instance's`);
  }
});

test("an owner probe that throws keeps the entry", () => {
  // Unanswerable is not evidence the owner is gone. Keeping costs a stale line; dropping loses a live
  // instance's only record of a running process.
  const kept = entriesOwnedElsewhere(
    [{ id: "p1", pid: 1, owner: OTHER }],
    { ownerIsAlive: () => { throw new Error("no probe"); }, self: SELF },
  );
  assert.deepEqual(kept.map((e) => e.id), ["p1"]);
});

test("`self` defaults to this process, so a real call needs only the probe", () => {
  const mine = entriesOwnedElsewhere([{ id: "p1", pid: 1, owner: process.pid }], { ownerIsAlive: () => true });
  assert.deepEqual(mine, [], "this process's own entry was treated as another instance's");
});

// ── the file half ───────────────────────────────────────────────────────────────────────────────

test("clearOwned with no keep still empties the record", () => {
  // The existing contract, unchanged for every caller that has nothing to preserve.
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 1, service: "a" });
  clearOwned(file);
  assert.deepEqual(readOwned(file), []);
});

test("clearOwned writes back exactly what it was told to keep", () => {
  const file = tmp();
  recordStarted(file, { id: "mine", pid: 1, service: "a" });
  recordStarted(file, { id: "theirs", pid: 2, service: "b", owner: OTHER });
  const keep = entriesOwnedElsewhere(readOwned(file), { ownerIsAlive: (pid) => pid === OTHER });
  clearOwned(file, { keep });
  assert.deepEqual(readOwned(file).map((e) => e.id), ["theirs"]);
});

test("a keep that is not an array empties rather than corrupting the file", () => {
  // A record that cannot be parsed is read as empty, so writing rubbish would silently disable the
  // reaper for every later instance. Emptying is the failure this file can recover from.
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 1, service: "a" });
  clearOwned(file, { keep: "not an array" });
  assert.deepEqual(readOwned(file), []);
});

test("the round trip preserves the kept entry's fields, not just its id", () => {
  // A kept entry has to remain reapable by the NEXT instance, and that needs the launcher to confirm
  // identity with and the owner to judge liveness by. Writing back a stripped entry would spare the
  // process now and make it unverifiable later, which is the same leak one step further on.
  const file = tmp();
  recordStarted(file, { id: "theirs", pid: 2, service: "b", launcher: "/l/claude-aify", owner: OTHER, startedAt: 7 });
  const keep = entriesOwnedElsewhere(readOwned(file), { ownerIsAlive: () => true });
  clearOwned(file, { keep });
  assert.deepEqual(readOwned(file), [
    { id: "theirs", pid: 2, service: "b", launcher: "/l/claude-aify", owner: OTHER, startedAt: 7 },
  ]);
});
