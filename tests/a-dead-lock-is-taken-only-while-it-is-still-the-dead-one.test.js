// The store takes over a dead holder's lock only while that lock is still the one it judged dead, and never
// leaves `.lock` absent under a live holder.
//
// The reviewer's schedule (review of 0.8.4, R1). R judges the dead lock D and is about to act. Meanwhile A takes D
// over itself and holds the lock across an awaited producer, as `admitStart` does while a worker is made. R then
// acts. The 0.8.2 store deleted `.lock` by path, which deleted A's lock. The 0.8.4 store renamed it aside to judge
// it, which captured A's lock too and left `.lock` absent until it was linked back: a third writer committed in
// that gap. Here A arrives at R's first act on the lock, whichever call that is (the rename then, the break lock
// now), so the same schedule reaches every version. Every removal of `.lock` is recorded with whether A held it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { breakPath, clearDeadBreak, removeLockIfStill } from "../lib/lock-break.mjs";

const installed = new Set(["claude"]);
const agent = (name) => ({ name, role: "coder", harness: "claude", mode: "managed", workspace: "C:/work", model: "",
  effort: "", instructions: "", env: {}, herdrSpace: true });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const revisionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "lead.json"), "utf8")).revision;

async function storeWithOneDefinition() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-race-"));
  const store = new DefinitionStore({ dir, lockWaitMs: 300 });
  await store.set("lead", agent("Before"), { installed });
  const listing = await store.list();
  const current = listing.definitions.find((row) => row.id === "lead");
  const launch = { agentId: "lead", runtime: "claude-code",
    definition: { storeId: listing.storeId, incarnation: current.incarnation, revision: current.revision } };
  return { dir, store, launch, lockPath: path.join(dir, ".lock") };
}

test("a lock taken over by another writer between the judgement and the act is never removed, and nothing commits under it", async () => {
  const { dir, store, launch, lockPath } = await storeWithOneDefinition();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), atMs: 1, nonce: "dead", host: os.hostname() }));

  const entered = deferred();
  const release = deferred();
  let producerDone = false;
  let holding = null;
  let arrived = false;
  let aHolds = false;
  const removedWhileAHeld = [];
  const { openSync, renameSync, unlinkSync } = fs;
  const aArrives = () => {
    if (arrived) return;
    arrived = true; // A's own acts on the lock come through these same calls
    holding = store.admitStart(launch, async () => {
      entered.resolve();
      await release.promise;
      producerDone = true;
      return { fixture: "awaited producer" };
    });
    aHolds = true;
  };
  const isLock = (target) => path.resolve(String(target)) === path.resolve(lockPath);
  const removing = (target) => {
    if (isLock(target) && aHolds) removedWhileAHeld.push(fs.readFileSync(lockPath, "utf8"));
  };
  fs.openSync = (target, flags, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(breakPath(lockPath))) aArrives();
    return openSync(target, flags, ...rest);
  };
  fs.renameSync = (from, ...rest) => { if (isLock(from)) { aArrives(); removing(from); } return renameSync(from, ...rest); };
  fs.unlinkSync = (target, ...rest) => { if (isLock(target)) { aArrives(); removing(target); } return unlinkSync(target, ...rest); };
  let writer;
  try {
    // R: a writer that finds the dead lock, judges it, and acts.
    writer = new DefinitionStore({ dir, lockWaitMs: 5000 }).set("lead", agent("After"), { installed });
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(revisionOf(dir), 1, "nothing commits while A's producer runs");
    aHolds = false;
    release.resolve();
    const produced = await holding;
    assert.deepEqual(produced, { produced: { fixture: "awaited producer" } }, "A kept its lock to the end");
    const committed = await writer;
    assert.equal(committed.revision, 2, "the writer commits after A releases");
  } finally {
    fs.openSync = openSync;
    fs.renameSync = renameSync;
    fs.unlinkSync = unlinkSync;
  }
  assert.ok(holding, "A was scheduled into the takeover");
  assert.ok(producerDone);
  assert.deepEqual(removedWhileAHeld, [], "A's live lock was never removed from `.lock`");
  assert.equal(fs.existsSync(lockPath) || fs.existsSync(breakPath(lockPath)), false, "nothing left held");
});

test("CONTROL: with no competitor, the dead lock is taken and released", async () => {
  const { dir, lockPath } = await storeWithOneDefinition();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), atMs: 1, nonce: "dead", host: os.hostname() }));
  await new DefinitionStore({ dir, lockWaitMs: 300 }).list();
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(breakPath(lockPath)), false);
});

test("a breaker that died holding the break lock stops takeovers until `unlock` clears it; a running one is left", async () => {
  const { dir, lockPath } = await storeWithOneDefinition();
  const deadLock = JSON.stringify({ pid: deadPid(), atMs: 1, nonce: "dead", host: os.hostname() });
  fs.writeFileSync(lockPath, deadLock);
  fs.writeFileSync(breakPath(lockPath), JSON.stringify({ pid: process.pid, atMs: 1, host: os.hostname() }));
  await assert.rejects(new DefinitionStore({ dir, lockWaitMs: 150 }).list(), /which is not running/,
    "a takeover waits while someone holds the break lock");
  assert.throws(() => DefinitionStore.unlock({ dir }), /another process is taking it over/, "a running breaker is left alone");
  assert.equal(fs.readFileSync(lockPath, "utf8"), deadLock, "control: nothing removed under a running breaker");

  fs.writeFileSync(breakPath(lockPath), JSON.stringify({ pid: deadPid(), atMs: 1, host: os.hostname() }));
  assert.equal(DefinitionStore.unlock({ dir }).pid > 0, true);
  assert.equal(fs.existsSync(lockPath) || fs.existsSync(breakPath(lockPath)), false, "both cleared");
  await new DefinitionStore({ dir, lockWaitMs: 150 }).list();
});

test("removeLockIfStill deletes only the judged text, and clearDeadBreak leaves a running or a young torn breaker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-break-"));
  const lockPath = path.join(dir, ".lock");
  fs.writeFileSync(lockPath, "live");
  assert.equal(removeLockIfStill(lockPath, "judged"), false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "live", "another text is left in place");
  assert.equal(removeLockIfStill(lockPath, "live"), true);
  assert.equal(fs.existsSync(lockPath) || fs.existsSync(breakPath(lockPath)), false);

  const alive = (pid) => pid === process.pid;
  fs.writeFileSync(breakPath(lockPath), "{torn");
  assert.equal(clearDeadBreak(lockPath, { processAlive: alive }), null, "a torn breaker younger than a minute stays");
  assert.deepEqual(clearDeadBreak(lockPath, { processAlive: alive, now: Date.now() + 61_000 }), { torn: "{torn" });
  fs.writeFileSync(breakPath(lockPath), JSON.stringify({ pid: process.pid }));
  assert.equal(clearDeadBreak(lockPath, { processAlive: alive }), null, "a running breaker stays");
  assert.equal(fs.existsSync(breakPath(lockPath)), true);
});
