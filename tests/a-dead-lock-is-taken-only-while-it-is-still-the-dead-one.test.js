// The store takes over a dead holder's lock only while that lock is still the one it judged dead.
//
// It re-read the dead lock and then deleted `.lock` by path, so a live writer whose lock replaced the dead one
// between the two lost its lock to the deletion (review of 0.8.2, R1). The competitor's arrival is scheduled at
// the moment the takeover acts on `.lock`, whichever call it acts with, so the same schedule reaches the old
// code and the new.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";

test("a live lock that replaced the dead one at the takeover survives it, and the call waits for it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-race-"));
  const lockPath = path.join(dir, ".lock");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, atMs: 1, nonce: "dead", host: os.hostname() }));
  const live = JSON.stringify({ pid: process.pid, atMs: Date.now(), nonce: "competitor", host: os.hostname() });

  const { unlinkSync, renameSync } = fs;
  let arrived = false;
  const competitorArrives = (target) => {
    if (!arrived && path.resolve(String(target)) === path.resolve(lockPath)) {
      arrived = true;
      fs.writeFileSync(lockPath, live);
    }
  };
  fs.unlinkSync = (target, ...rest) => { competitorArrives(target); return unlinkSync(target, ...rest); };
  fs.renameSync = (from, ...rest) => { competitorArrives(from); return renameSync(from, ...rest); };
  try {
    const store = new DefinitionStore({ dir, lockWaitMs: 300 });
    await assert.rejects(store.list(), /locked by running process/, "the live holder is waited for");
  } finally {
    fs.unlinkSync = unlinkSync;
    fs.renameSync = renameSync;
  }
  assert.ok(arrived, "the competitor's lock was scheduled into the takeover");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, "competitor", "the live lock is still there");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".lock.taken-")), [], "nothing left aside");
});

test("CONTROL: with no competitor, the dead lock is taken and released", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-race-"));
  const lockPath = path.join(dir, ".lock");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, atMs: 1, nonce: "dead", host: os.hostname() }));
  await new DefinitionStore({ dir, lockWaitMs: 300 }).list();
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".lock.taken-")), []);
});
