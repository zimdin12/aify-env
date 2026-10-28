// The definition store's lock (lib/definition-lock.mjs), asked directly: the store's suite drives it through every
// store call, and this says which of its rules lives in the lock itself (split out of agent-definitions.mjs, 0.9.9).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { breakDefinitionLock, DefinitionLock } from "../lib/definition-lock.mjs";

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-definition-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A pid that was a process on this host and is not any more. */
const deadPid = () => spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout * 1;
const plant = (dir, holder) => fs.writeFileSync(path.join(dir, ".lock"), JSON.stringify(holder));

test("DefinitionLock: a live holder is waited for and named; a dead one on this host is taken over", async (t) => {
  const dir = store(t);
  const first = new DefinitionLock({ dir });
  await first.take();
  assert.ok(first.nonce, "a held lock has an id");
  await assert.rejects(new DefinitionLock({ dir, waitMs: 50 }).take(), new RegExp(`locked by running process ${process.pid}`));
  first.release();
  plant(dir, { pid: deadPid(), atMs: 0, nonce: "x", host: os.hostname() });
  const second = new DefinitionLock({ dir, waitMs: 50 });
  await second.take();
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, ".lock"), "utf8")).nonce, "x", "the dead holder's lock was not taken over");
  plant(dir, { pid: deadPid(), atMs: 0, nonce: "y", host: "another-host" });
  await assert.rejects(new DefinitionLock({ dir, waitMs: 50 }).take(), /locked by process/, "CONTROL: another host's holder is never taken over");
});

test("DefinitionLock: check refuses once the lock is not this hold's, and release removes only its own", async (t) => {
  const dir = store(t);
  const hold = new DefinitionLock({ dir });
  await hold.take();
  hold.check();
  plant(dir, { pid: process.pid, atMs: 0, nonce: "someone-else", host: os.hostname() });
  assert.throws(() => hold.check(), /taken from this operation/);
  hold.release();
  assert.ok(fs.existsSync(path.join(dir, ".lock")), "release removed a lock that was not its own");
  assert.equal(hold.nonce, null);
});

test("breakDefinitionLock: nothing to break is null, a live holder is refused, a dead one's lock is removed and named", (t) => {
  const dir = store(t);
  assert.equal(breakDefinitionLock(dir), null);
  plant(dir, { pid: process.pid, atMs: 0, nonce: "live", host: os.hostname() });
  assert.throws(() => breakDefinitionLock(dir), /held by running process/);
  assert.ok(fs.existsSync(path.join(dir, ".lock")), "a live holder's lock was removed");
  const pid = deadPid();
  plant(dir, { pid, atMs: 0, nonce: "dead", host: os.hostname() });
  assert.equal(breakDefinitionLock(dir).pid, pid);
  assert.equal(fs.existsSync(path.join(dir, ".lock")), false);
});
