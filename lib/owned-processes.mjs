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
    startedAt: Number(entry.startedAt ?? Date.now()),
  });
  write(file, kept);
}

/** Forget a process. Unknown ids are fine: a reaper racing a stop must not fail for being second. */
export function recordStopped(file, id) {
  write(file, readOwned(file).filter((e) => e.id !== id));
}

/** Forget everything — used once the previous instance's leftovers have been dealt with. */
export function clearOwned(file) {
  write(file, []);
}
