// A file written so that a crash leaves either the old contents or the new, never a torn mix.
//
// Taken out of the definition store, which was its only user, because the generation file and the turns file of the
// 0.9 publication (P0 C3, C5) need the same thing. Write a temporary file and fsync it, rename it over the target,
// retrying while Windows refuses a rename it will allow a moment later, then sync the directory where the platform
// can. `guard` runs before every rename attempt, so a caller holding a lock can stop a retry that would land after
// the lock moved; it throws to stop.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How long a refused rename is retried: Windows refuses one while another process has the target open. */
const RENAME_RETRY_MS = 2000;
const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write `text` to `tempPath` and fsync it, so the bytes are on disk before anything points at them. */
export function writeTempDurably(tempPath, text) {
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Rename `from` over `to`, retried while Windows refuses it, then make the rename durable where Node can. */
export function renameDurably(from, to, { renameSync = fs.renameSync, guard = () => {}, retryMs = RENAME_RETRY_MS } = {}) {
  const deadline = Date.now() + retryMs;
  for (;;) {
    guard();
    try {
      renameSync(from, to);
      break;
    } catch (error) {
      if (!RETRYABLE_RENAME.has(error.code) || Date.now() >= deadline) throw error;
      sleepSync(20);
    }
  }
  syncDirectory(path.dirname(to));
}

/** The whole write: a temporary file beside the target, made durable, then renamed over it. */
export function writeFileDurably(target, text, { temp = `${target}.${process.pid}.${randomUUID()}.tmp`, ...rename } = {}) {
  writeTempDurably(temp, text);
  try {
    renameDurably(temp, target, rename);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** POSIX makes a rename durable by fsyncing the directory; Windows has no such call from Node. */
function syncDirectory(dir) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
