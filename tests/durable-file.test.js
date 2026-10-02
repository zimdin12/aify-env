// A file written so a crash leaves the old contents or the new, never a torn mix (lib/durable-file.mjs).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renameDurably, writeFileDurably, writeTempDurably } from "../lib/durable-file.mjs";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-durable-"));

test("A DURABLE WRITE that fails leaves the target as it was and no temporary file behind", () => {
  const dir = scratch();
  const target = path.join(dir, "t.txt");
  fs.writeFileSync(target, "old");
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  assert.throws(() => writeFileDurably(target, "new", { renameSync: () => { throw busy; }, retryMs: 50 }), /busy/);
  assert.equal(fs.readFileSync(target, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["t.txt"], "the temporary file was left behind");
  let tries = 0;
  writeFileDurably(target, "new", { renameSync: (a, b) => { if (++tries < 3) throw busy; fs.renameSync(a, b); } });
  assert.deepEqual([fs.readFileSync(target, "utf8"), tries], ["new", 3], "a rename Windows refuses for a moment is retried");
  const stop = new Error("lock moved");
  assert.throws(() => writeFileDurably(target, "newer", { guard: () => { throw stop; } }), /lock moved/);
  assert.equal(fs.readFileSync(target, "utf8"), "new", "a guard that throws stops the rename");
});

test("A TEMPORARY FILE THAT FAILS PART WRITTEN is removed, and the write's own failure is the one thrown (G3)", () => {
  const dir = scratch();
  const target = path.join(dir, "t.txt");
  fs.writeFileSync(target, "old");
  const fsyncFailed = Object.assign(new Error("fsync failed"), { code: "EIO" });
  const partWritten = (temp, text) => { fs.writeFileSync(temp, text.slice(0, 2)); throw fsyncFailed; };
  assert.throws(() => writeFileDurably(target, "new", { writeTemp: partWritten }), (error) => error === fsyncFailed);
  assert.deepEqual([fs.readFileSync(target, "utf8"), fs.readdirSync(dir)], ["old", ["t.txt"]], "no temporary file is left, the target is as it was");
  const temp = path.join(dir, "held.tmp");
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(temp, "inside"), "x");
  assert.throws(() => writeFileDurably(target, "new", { temp, writeTemp: () => { throw fsyncFailed; } }), (error) => error === fsyncFailed,
    "a cleanup that cannot remove its temporary path does not replace the write's failure");
});

test("THE TWO STEPS the definition store composes itself: a durable temporary file, then a guarded rename", () => {
  const dir = scratch();
  const temp = path.join(dir, "x.tmp");
  const target = path.join(dir, "x.json");
  writeTempDurably(temp, "{}");
  assert.equal(fs.readFileSync(temp, "utf8"), "{}");
  let guarded = 0;
  renameDurably(temp, target, { guard: () => { guarded += 1; } });
  assert.deepEqual([fs.existsSync(temp), fs.readFileSync(target, "utf8"), guarded], [false, "{}", 1]);
  const missing = path.join(dir, "absent.tmp");
  assert.throws(() => renameDurably(missing, target), { code: "ENOENT" }, "a rename that cannot be retried is not");
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
});
