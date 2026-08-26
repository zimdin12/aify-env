// What this environment owns, written where a LATER instance can read it.
//
// The in-memory registry answers "what do I own" for as long as this process lives. It cannot answer
// it for the process that replaces one which died, and that is the question that matters: every agent
// started by a dead aify-env is still running, and nothing left behind can name them.
//
// STATE, NOT EVENTS. A shutdown handler covers the graceful paths and misses the one that matters --
// a hard kill runs no handler at all. So this file is the authority and the next instance reaps from
// it at startup. Cleanup that must hold on EVERY path keys on state; this project has an incident
// behind that rule.
//
// FAILS SAFE IN ONE DIRECTION ONLY. Every read degrades to "no processes" rather than throwing,
// because an environment that refuses to start over damaged bookkeeping has turned a leak into an
// outage. Writes are best-effort for the same reason: losing a record costs a leaked process, and
// crashing the environment costs every process it was managing.

import fs from "node:fs";
import path from "node:path";

/** A record is only usable if it can name a process. Anything else is noise and is dropped. */
function isProcessRecord(value) {
  return (
    typeof value === "object"
    && value !== null
    && typeof value.id === "string"
    && Number.isInteger(value.pid)
  );
}

/**
 * The processes a previous (or this) instance wrote down.
 *
 * @returns {Array<{id: string, pid: number, service: string, startedAt: number}>}
 */
export function readOwned(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // Missing is the normal first-run state, not a fault.
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt. Reported as empty so the environment starts; the record rebuilds from what runs next.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isProcessRecord);
}

function write(file, entries) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  } catch {
    // Best effort. A lost record leaks one process; a throw here would take down the environment that
    // is managing all of them.
  }
}

/** Note a process as owned. Replaces any record with the same id, so a restart cannot double-count. */
export function recordStarted(file, entry) {
  const kept = readOwned(file).filter((e) => e.id !== entry.id);
  kept.push({
    id: String(entry.id),
    pid: Number(entry.pid),
    service: String(entry.service ?? ""),
    // The launcher is recorded so a later instance can CONFIRM a pid is still ours before killing it.
    // Without something to match against, the reaper's only options are trusting a bare pid or never
    // reaping, and the first of those ends strangers' processes.
    launcher: String(entry.launcher ?? ""),
    // WHICH INSTANCE OWNS THIS, so a later one can tell an orphan from somebody else's live process.
    // The record was anonymous, and the reaper's only protection against reaping a RUNNING
    // environment's processes was that it reaps after taking the port: holding the port was taken as
    // proof that nobody else is serving. An instance started on port 0 gets an ephemeral port, which
    // is always free, so it holds a port while owning nothing and the proof does not hold. That is
    // not hypothetical -- an aify-comms test started the daemon that way three times in one evening
    // and killed the operator's fleet each time.
    owner: Number(entry.owner ?? process.pid),
    startedAt: Number(entry.startedAt ?? Date.now()),
  });
  write(file, kept);
}

/** Forget a process. Unknown ids are fine: a reaper racing a stop must not fail for being second. */
export function recordStopped(file, id) {
  write(file, readOwned(file).filter((e) => e.id !== id));
}

/**
 * Forget everything EXCEPT `keep` — used once the previous instance's leftovers have been dealt with,
 * and again at shutdown.
 *
 * `keep` EXISTS BECAUSE EMPTYING THE FILE IS NOT ALWAYS RIGHT. The record is shared by path, so when a
 * second instance runs it holds entries this instance must not touch. The orphan reaper already
 * declines to KILL those; emptying the file afterwards destroyed them anyway, which left the live
 * instance running processes that nothing had written down. Its workers then survive only until it is
 * hard-killed, at which point they are unreapable -- the exact leak this record exists to prevent.
 *
 * Not a race-free merge, and it does not pretend to be: another instance can record a process between
 * the read and this write. The honest fix for that is two instances not sharing a record file at all,
 * which is what `AIFY_ENV_PROCESS_RECORD` is for. This narrows a certain loss to an unlikely one.
 */
export function clearOwned(file, { keep = [] } = {}) {
  write(file, Array.isArray(keep) ? keep : []);
}

/**
 * The entries belonging to a DIFFERENT instance that is still running.
 *
 * Pure: the decision, separate from reading or writing the file, so both call sites ask the same
 * question and it can be tested without a live process. An entry with no owner is not "somebody
 * else's" -- an entry written before the field existed is exactly the crash leftover the reaper is
 * for, and treating it as protected would disable recovery for the case that matters.
 *
 * @param {Array<{owner?: number}>} entries
 * @param {{ownerIsAlive: (pid: number) => boolean, self?: number}} probes
 */
export function entriesOwnedElsewhere(entries, { ownerIsAlive, self = process.pid }) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const owner = Number(entry?.owner);
    if (!Number.isInteger(owner) || owner <= 0) return false;
    if (owner === Number(self)) return false;
    try {
      return ownerIsAlive(owner) === true;
    } catch {
      // Unanswerable is not evidence the owner is gone. Keeping the entry costs a stale line; dropping
      // it loses a live instance's only record of a running process.
      return true;
    }
  });
}
