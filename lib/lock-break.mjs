// Removing a lock file its owner did not release: a dead holder's, taken over by the store, or the operator's
// `aify-env agents unlock`.
//
// A FILE IS DELETED ONLY BY ITS GUARD'S HOLDER, AND ONLY WHILE IT STILL HOLDS WHAT WAS JUDGED. The guard for a file
// whose text is T is `<dir>/.lock.guard-<sha256(T)>`, created exclusively. Its holder re-reads the file and deletes
// it only if it still holds T. While that guard is held, the file at that path cannot stop holding T underneath:
// - a new holder creates a lock only where none exists, so it cannot replace T in place;
// - T's own holder is dead (that is why it is being removed);
// - anyone else deleting T needs this same guard.
// So exactly T is deleted, never a live file that replaced it.
//
// History, in the order each version was broken:
// - The store re-read the dead lock, then deleted `.lock` by path, which deleted a live lock that had replaced it
//   (review of 0.8.2).
// - It then renamed the lock aside to judge it, which captured a live lock and left `.lock` absent while a third
//   writer committed (review of 0.8.4, R1).
// - A single break lock fixed that, but clearing a dead break lock deleted it by path, which deleted a live
//   breaker's (review of ba486a4).
//
// A guard is itself such a file. A guard whose holder died is removed by the same rule one level up: its guard is
// named by ITS text. Each level is needed only when the holder below it died, and the depth is bounded. A guard is
// made by hard-linking a fully written temporary file into place, so it is never torn: every guard names its
// holder.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GUARD = ".lock.guard-";
const MAX_DEPTH = 4;

/** The guard that must be held to delete `target` while it holds `text`. */
export function guardFor(target, text) {
  return path.join(path.dirname(target), `${GUARD}${createHash("sha256").update(text).digest("hex")}`);
}

/**
 * Delete `target` if it still holds `judgedText`, holding its guard. Returns true when it was deleted. Returns false
 * when the guard is held, or when `target` is gone or holds something else; the caller waits and judges again. A
 * guard whose holder is a process on this host that is not running is removed by the same rule, so the next attempt
 * can take it.
 */
export function removeIfStill(target, judgedText, { processAlive, pid = process.pid, depth = 0 }) {
  if (depth > MAX_DEPTH) return false;
  const guard = guardFor(target, judgedText);
  if (!takeGuard(guard, pid)) {
    reclaimIfDead(guard, { processAlive, pid, depth });
    return false;
  }
  try {
    let now;
    try {
      now = fs.readFileSync(target, "utf8");
    } catch {
      return false;
    }
    if (now !== judgedText) return false;
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  } finally {
    // Ours: a live holder's guard is never removed by anyone else (above), so the path still names it.
    fs.rmSync(guard, { force: true });
  }
}

/** The operator's sweep: remove every guard in `dir` whose holder is not running. Returns how many. */
export function sweepDeadGuards(dir, { processAlive, pid = process.pid }) {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(GUARD) || name.endsWith(".tmp")) continue;
    if (reclaimIfDead(path.join(dir, name), { processAlive, pid, depth: 0 })) removed += 1;
  }
  return removed;
}

/** Create `guard` with a holder record, exclusively: written aside, then hard-linked into place. */
function takeGuard(guard, pid) {
  const temporary = `${guard}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ pid, host: os.hostname(), atMs: Date.now(), nonce: randomUUID() }));
    fs.linkSync(temporary, guard);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function reclaimIfDead(guard, { processAlive, pid, depth }) {
  let text;
  let holder;
  try {
    text = fs.readFileSync(guard, "utf8");
    holder = JSON.parse(text);
  } catch {
    return false;
  }
  if (!holder || holder.host !== os.hostname() || processAlive(holder.pid)) return false;
  return removeIfStill(guard, text, { processAlive, pid, depth: depth + 1 });
}
