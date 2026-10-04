// Removing a lock file its owner did not release: a dead holder's, taken over by the store, or the operator's
// `aify-env agents unlock`.
//
// ONE BREAKER AT A TIME, and `.lock` is never moved. The store's earlier takeover re-read the dead lock and then
// deleted it by path, which deleted a live writer's lock that had replaced it (review of 0.8.2). Its successor
// renamed the lock aside to judge it, which captured a live lock just the same and left `.lock` absent until it
// was linked back. A third writer committed inside that gap while the live holder was still producing (review of
// 0.8.4, R1, reproduced on the real store).
//
// So a breaker first takes `<lock>.break` (exclusive create), then re-reads `.lock`, and deletes it only if it
// still holds the text that was judged. While the break lock is held, `.lock` cannot change underneath:
// - a new holder creates `.lock` only when it is absent (`wx`), so it cannot replace the judged one;
// - the judged holder is dead, so it does not release it;
// - every other breaker, the operator's unlock included, is waiting on the break lock.
// What is deleted is therefore exactly the lock that was judged, and a live lock is never touched.
//
// A breaker that dies holding the break lock (a few synchronous calls wide) leaves it behind. Takeovers then
// wait, and the waiting call names `aify-env agents unlock`, which clears a break lock whose holder is not
// running.

import fs from "node:fs";
import os from "node:os";

/** The break lock beside `lockPath`. */
export const breakPath = (lockPath) => `${lockPath}.break`;

/**
 * Delete `lockPath` if it still holds `judgedText`, under the break lock. Returns true when it was deleted. Returns
 * false when another breaker holds the break lock, or when `.lock` is gone or no longer the judged text. The
 * caller waits and judges again.
 */
export function removeLockIfStill(lockPath, judgedText, { pid = process.pid } = {}) {
  let fd;
  try {
    fd = fs.openSync(breakPath(lockPath), "wx");
  } catch {
    return false;
  }
  try {
    try {
      fs.writeSync(fd, JSON.stringify({ pid, atMs: Date.now(), host: os.hostname() }));
    } finally {
      fs.closeSync(fd);
    }
    let now;
    try {
      now = fs.readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    if (now !== judgedText) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(breakPath(lockPath), { force: true });
  }
}

/**
 * The operator's half: remove a break lock left by a breaker that is no longer running. Returns what it removed, or
 * null. A break lock whose holder is running is left in place. So is a torn one younger than a minute, since a live
 * breaker may be between its create and its write.
 */
export function clearDeadBreak(lockPath, { processAlive, now = Date.now() }) {
  const file = breakPath(lockPath);
  let text;
  let stat;
  try {
    text = fs.readFileSync(file, "utf8");
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let holder = null;
  try { holder = JSON.parse(text); } catch { /* torn */ }
  if (holder ? processAlive(holder.pid) : now - stat.mtimeMs < 60_000) return null;
  fs.rmSync(file, { force: true });
  return holder ?? { torn: text };
}
