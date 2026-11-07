import { sameLinuxStartToken } from './linux-process-token.mjs';
import { validBirth, sameBirth, originalBirthState } from './process-birth.mjs';

// Deciding what a dead instance left behind. IO belongs to the shared identity probe; this is a pure plan.
// Unknown identity is never permission to kill. Owner-record retention/termination confirmation is the #17 lane.

/**
 * @param {Array<{id: string, pid: number, service: string, owner?: number, startedAt: number}>} entries
 * @param {{isAlive: (pid: number) => boolean, verify: (entry: object) => boolean,
 *          ownerIsAlive?: (pid: number) => boolean}} probes
 *   `verify` answers "is this pid still the process we recorded". How that is established is platform
 *   work and belongs to the caller; the decision does not change with the technique.
 *   `ownerIsAlive` answers "is the instance that wrote this entry still running". Defaults to
 *   `isAlive`, since it is the same question asked of a different pid.
 * @returns {{reap: object[], skipped: Array<{entry: object, reason: string}>}}
 */
export function planOrphanReap(entries, { isAlive, verify, ownerIsAlive, ownerState = null }) {
  // AN ENTRY WHOSE OWNER IS STILL RUNNING IS NOT AN ORPHAN. It is another live instance's process, and
  // the whole record is about cleaning up after an instance that DIED.
  //
  // The guard this replaces lived in `bin/aify-env.mjs`: reap only after taking the port, on the
  // reasoning that holding the port proves nobody else is serving. It is right for a second start on
  // the SAME port and useless for `--port 0`, where an ephemeral port is always free -- so an instance
  // that owns nothing passes the guard and reaps a running environment's whole fleet. Measured three
  // times on 2026-08-26, each time a pair of managed workers dying three seconds apart.
  //
  // Missing `owner` keeps the OLD behaviour rather than failing closed, deliberately: an entry written
  // before this field existed is exactly the crash leftover the reaper is for, and refusing to touch
  // it would disable recovery for the case that matters. Skipping is limited to an owner that is
  // present AND alive.
  const ownerProbe = typeof ownerIsAlive === "function" ? ownerIsAlive : isAlive;
  const reap = [];
  const skipped = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    let alive;
    try {
      alive = isAlive(entry.pid);
    } catch {
      alive = null;
    }
    if (alive !== true) {
      skipped.push({ entry, state: alive === false ? 'gone' : 'unknown',
        reason: alive === false ? 'already gone' : 'process liveness is unknown' });
      continue;
    }

    const owner = Number(entry.owner);
    let state = 'allowed';
    try {
      if (typeof ownerState === 'function') state = ownerState(entry);
      else if (Number.isInteger(owner) && owner > 0) {
        const observed = ownerProbe(owner);
        state = observed === false ? 'allowed' : observed === true ? 'protected' : 'unknown';
      }
    } catch { state = 'unknown'; }
    if (state !== 'allowed') {
      skipped.push({ entry, state: state === 'protected' ? 'protected' : 'unknown',
        reason: state === 'protected' ? `its owner (pid ${owner}) is still running` : `its owner (pid ${owner}) could not be verified gone` });
      continue;
    }

    let ours;
    try {
      ours = verify(entry) === true;
    } catch {
      // Unverifiable is NOT permission. The leak is recoverable; killing a stranger is not.
      ours = false;
    }
    if (!ours) {
      skipped.push({ entry, state: 'unknown', reason: "not ours any more" });
      continue;
    }

    reap.push(entry);
  }

  return { reap, skipped };
}

/** Original-owner permission, separate from child identity and from confirming cleanup. */
export function ownerReapState(entry, { observed, displaced = null, platform = process.platform }) {
  const owner = Number(entry?.owner), hasBirth = Object.hasOwn(entry ?? {}, 'ownerIdentity');
  if (!Number.isSafeInteger(owner) || owner <= 0) return hasBirth ? 'unknown' : 'allowed';
  const birth = validBirth(entry.ownerIdentity, owner);
  if (hasBirth && !birth) return 'unknown';
  // Only a stored owning-writer birth can use the still-live displaced-owner exception.
  if (birth && sameBirth(birth, displaced, owner)) return 'allowed';
  const answer = observed?.get(owner);
  if (birth) {
    const state = originalBirthState(birth, answer, platform);
    return state === 'gone' ? 'allowed' : state === 'present' ? 'protected' : 'unknown';
  }
  return answer?.alive === false ? 'allowed' : answer?.alive === true ? 'protected' : 'unknown';
}

/** The Windows record's legacy start-time tolerance, compared at its original millisecond precision. */
export const START_TIME_TOLERANCE_MS = 30_000;

/** A recorded process and one shared OS observation. No IO, PID backfill or per-entry subprocess. */
export function defaultVerify(entry, { platform = process.platform, answer } = {}) {
  const launcher = String(entry?.launcher ?? '').trim();
  if (!launcher || !Number.isSafeInteger(entry?.pid) || entry.pid <= 0 || answer?.alive !== true) return false;
  if (platform === 'linux') {
    return answer.platform === 'linux' && sameLinuxStartToken(entry.startToken, answer.startToken, entry.pid)
      && typeof answer.commandLine === 'string' && answer.commandLine.split('\0').includes(launcher);
  }
  if (platform !== 'win32' || Object.hasOwn(entry, 'startToken')) return false;
  const recorded = Number(entry.startedAt ?? 0);
  if (!recorded || !Number.isSafeInteger(answer.createdAtUs) || answer.createdAtUs <= 0) return false;
  // Preserve the old reaper's Date.parse millisecond policy; resident admission retains all microseconds.
  const actual = Math.floor(answer.createdAtUs / 1000);
  if (Math.abs(actual - recorded) > START_TIME_TOLERANCE_MS) return false;
  if (typeof answer.commandLine !== 'string' || !answer.commandLine.trim()) return false;
  const flat = value => value.split(String.fromCharCode(92)).join('/').toLowerCase();
  return flat(answer.commandLine).includes(flat(launcher));
}
