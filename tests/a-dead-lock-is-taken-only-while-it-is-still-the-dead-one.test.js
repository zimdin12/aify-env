// The store takes over a dead holder's lock only while that lock is still the one it judged dead, and never
// leaves `.lock` absent under a live holder.
//
// The reviewer's schedule (review of 0.8.4, R1). R judges the dead lock D and is about to act. Meanwhile A takes D
// over itself and holds the lock across an awaited producer, as `admitStart` does while a worker is made. R then
// acts. The 0.8.2 store deleted `.lock` by path, which deleted A's lock. The 0.8.4 store renamed it aside to judge
// it, which captured A's lock too and left `.lock` absent until it was linked back: a third writer committed in
// that gap. Here A arrives at R's first act on the lock, whichever call that is (the rename then, taking the guard
// now), so the same schedule reaches every version. Every removal of `.lock` is recorded with whether A held it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { guardFor, removeIfStill, sweepDeadGuards } from "../lib/lock-break.mjs";

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
  const { linkSync, renameSync, unlinkSync } = fs;
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
  fs.linkSync = (from, to, ...rest) => {
    if (path.basename(String(to)).startsWith(".lock.guard-")) aArrives();
    return linkSync(from, to, ...rest);
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
    fs.linkSync = linkSync;
    fs.renameSync = renameSync;
    fs.unlinkSync = unlinkSync;
  }
  assert.ok(holding, "A was scheduled into the takeover");
  assert.ok(producerDone);
  assert.deepEqual(removedWhileAHeld, [], "A's live lock was never removed from `.lock`");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".lock")), [], "nothing left held");
});

test("CONTROL: with no competitor, the dead lock is taken and released", async () => {
  const { dir, lockPath } = await storeWithOneDefinition();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), atMs: 1, nonce: "dead", host: os.hostname() }));
  await new DefinitionStore({ dir, lockWaitMs: 300 }).list();
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".lock")), []);
});

const deadRecord = () => JSON.stringify({ pid: deadPid(), host: os.hostname(), atMs: 1, nonce: "dead-guard" });
const liveRecord = () => JSON.stringify({ pid: process.pid, host: os.hostname(), atMs: Date.now(), nonce: "live-guard" });
const alive = (pid) => pid === process.pid;

test("a guard left by a breaker that died is reclaimed by the next takeover; a running breaker's is waited for", async () => {
  const { dir, lockPath } = await storeWithOneDefinition();
  const deadLock = JSON.stringify({ pid: deadPid(), atMs: 1, nonce: "dead", host: os.hostname() });
  fs.writeFileSync(lockPath, deadLock);
  fs.writeFileSync(guardFor(lockPath, deadLock), liveRecord());
  await assert.rejects(new DefinitionStore({ dir, lockWaitMs: 150 }).list(), /which is not running/,
    "a takeover waits while a running breaker holds the guard");
  assert.throws(() => DefinitionStore.unlock({ dir }), /another process is taking it over/, "unlock leaves a running breaker");
  assert.equal(fs.readFileSync(lockPath, "utf8"), deadLock, "control: nothing removed under a running breaker");

  fs.writeFileSync(guardFor(lockPath, deadLock), deadRecord());
  await new DefinitionStore({ dir, lockWaitMs: 1000 }).list();
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".lock")), [], "the dead guard and the dead lock are gone");
});

test("clearing a dead guard never deletes a live guard that took its name meanwhile (review of ba486a4)", () => {
  // U (the operator's unlock) judges G0, a dead breaker's guard for the dead lock D. Before U acts, another cleanup
  // clears G0 and R, a live breaker, takes the same guard name for D. U must leave R's guard, and so must not
  // remove D under it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-guard-"));
  const lockPath = path.join(dir, ".lock");
  const deadLock = JSON.stringify({ pid: deadPid(), atMs: 1, nonce: "dead", host: os.hostname() });
  fs.writeFileSync(lockPath, deadLock);
  const g0Path = guardFor(lockPath, deadLock);
  const g0 = deadRecord();
  fs.writeFileSync(g0Path, g0);
  const r = liveRecord();

  const { linkSync } = fs;
  let scheduled = false;
  fs.linkSync = (from, to, ...rest) => {
    if (!scheduled && path.resolve(String(to)) === path.resolve(guardFor(g0Path, g0))) {
      scheduled = true;
      assert.equal(removeIfStill(g0Path, g0, { processAlive: alive }), true, "the other cleanup clears G0");
      fs.writeFileSync(g0Path, r, { flag: "wx" }); // R takes the guard for D
    }
    return linkSync(from, to, ...rest);
  };
  try {
    assert.throws(() => DefinitionStore.unlock({ dir }), /another process is taking it over/);
  } finally {
    fs.linkSync = linkSync;
  }
  assert.ok(scheduled, "the overlap was scheduled into U's act");
  assert.equal(fs.readFileSync(g0Path, "utf8"), r, "R's live guard survives");
  assert.equal(fs.readFileSync(lockPath, "utf8"), deadLock, "and nothing was removed under it");
});

test("removeIfStill deletes only the judged text; sweepDeadGuards removes only guards whose holder is not running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-guard-"));
  const lockPath = path.join(dir, ".lock");
  fs.writeFileSync(lockPath, "live");
  assert.equal(removeIfStill(lockPath, "judged", { processAlive: alive }), false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "live", "another text is left in place");
  assert.equal(removeIfStill(lockPath, "live", { processAlive: alive }), true);
  assert.deepEqual(fs.readdirSync(dir), [], "the guard is released with the file");

  fs.writeFileSync(guardFor(lockPath, "a"), deadRecord());
  fs.writeFileSync(guardFor(lockPath, "b"), liveRecord());
  assert.equal(sweepDeadGuards(dir, { processAlive: alive }), 1);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(guardFor(lockPath, "b"))], "the running holder's guard stays");
});
