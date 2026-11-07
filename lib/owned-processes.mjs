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
// FAILS SAFE IN ONE DIRECTION ONLY. Every read degrades to "no processes" rather than throwing, because an
// environment that refuses to start over damaged bookkeeping has turned a leak into an outage. Writes report failure
// rather than throwing, for the same reason: losing a record costs a leaked process, and crashing the environment
// costs every process it was managing.
//
// THESE ARE COMPATIBILITY ADAPTERS over OwnedProcessRecord (lib/owned-process-record.mjs), which owns the file's
// statuses, its single durable writer and its preservation of rows and bytes it cannot read. They keep their old
// shapes for existing callers and tests. New production code uses the class: `load()` says whether the file was
// missing, readable or unreadable, which `readOwned` cannot; `retire(expectedEntries)` removes exact recorded rows,
// where `recordStopped` matches an id and `clearOwned` matches a caller's keep list.

import { isDeepStrictEqual } from "node:util";
import { OwnedProcessRecord } from "./owned-process-record.mjs";

/**
 * The processes a previous (or this) instance wrote down. Missing, unreadable and damaged all read as none; rows
 * this version cannot use are left out here and left in the file.
 *
 * @returns {Array<{id: string, pid: number, service: string, startedAt: number}>}
 */
export function readOwned(file) {
  return new OwnedProcessRecord(file).load().entries;
}

/**
 * Note a process as owned. Replaces any record with the same id, so a restart cannot double-count. The launcher is
 * recorded so a later instance can CONFIRM a pid is still ours before killing it, and the OWNER (this process unless
 * the entry says otherwise) so it can tell an orphan from another live instance's process: an instance started on port
 * 0 holds a free ephemeral port while owning nothing, so holding the port proves nothing. That is not hypothetical --
 * an aify-comms test started the daemon that way three times in one evening and killed the operator's fleet each time.
 */
export function recordStarted(file, entry) {
  return new OwnedProcessRecord(file).started(entry);
}

/**
 * Forget a process by id. Unknown ids are fine: a reaper racing a stop must not fail for being second. Removes only
 * rows this call read with that id, never a row recorded after its read.
 */
export function recordStopped(file, id) {
  const record = new OwnedProcessRecord(file);
  return record.retire(record.load().entries.filter((e) => e.id === id));
}

/**
 * Forget every recognised row EXCEPT those structurally equal to one in `keep` -- used once the previous instance's
 * leftovers have been dealt with, and again at shutdown. A `keep` that is not a list keeps nothing.
 *
 * `keep` EXISTS BECAUSE EMPTYING THE FILE IS NOT ALWAYS RIGHT. The record is shared by path, so when a second instance
 * runs it holds entries this instance must not touch.
 *
 * A DELTA, NOT A REPLACEMENT. This removes rows it read and was not told to keep; it no longer writes `keep` back. So
 * a stale `keep` cannot resurrect a row removed since, a row recorded after this call's read is not erased, and rows
 * this version cannot read stay. A row recorded between the CALLER's earlier read and this call is still removed,
 * because it is not in `keep`: callers that hold a snapshot across awaits retire exact rows with the class instead.
 */
export function clearOwned(file, { keep = [] } = {}) {
  const kept = Array.isArray(keep) ? keep : [];
  const record = new OwnedProcessRecord(file);
  return record.retire(record.load().entries.filter((e) => !kept.some((k) => isDeepStrictEqual(k, e))));
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
