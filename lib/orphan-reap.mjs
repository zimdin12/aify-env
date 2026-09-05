import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Deciding what a dead instance left behind, and what may be killed.
//
// The operator's requirement is that processes managed by aify-env die with it. Shutdown handlers
// cover the graceful exits; this covers the one that matters, where the environment was killed
// outright and ran no handler at all. The next instance reads the record and cleans up.
//
// PID REUSE IS THE HAZARD. A pid written down before a crash can belong to something entirely
// unrelated by the time anyone reads it, and ending a stranger's process is a far worse failure than
// the leak being fixed. So the killing decision FAILS CLOSED: anything that cannot be confirmed as
// ours is left alone and reported, and an operator can deal with a leak they have been told about.
//
// A PURE PLAN, not an execution. Every branch is decidable without killing anything, which is what
// makes the dangerous half testable at all.

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
export function planOrphanReap(entries, { isAlive, verify, ownerIsAlive }) {
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
      // A probe that cannot answer is not evidence that the process is running, and "gone" is the
      // harmless reading: it means we do nothing.
      alive = false;
    }
    if (!alive) {
      skipped.push({ entry, reason: "already gone" });
      continue;
    }

    const owner = Number(entry.owner);
    if (Number.isInteger(owner) && owner > 0) {
      let ownerRunning;
      try {
        ownerRunning = ownerProbe(owner) === true;
      } catch {
        // A probe that cannot answer is not evidence the owner is gone, and treating it as gone is
        // what licenses the kill. Unanswerable means leave it alone.
        ownerRunning = true;
      }
      if (ownerRunning) {
        skipped.push({ entry, reason: `its owner (pid ${owner}) is still running` });
        continue;
      }
    }

    let ours;
    try {
      ours = verify(entry) === true;
    } catch {
      // Unverifiable is NOT permission. The leak is recoverable; killing a stranger is not.
      ours = false;
    }
    if (!ours) {
      skipped.push({ entry, reason: "not ours any more" });
      continue;
    }

    reap.push(entry);
  }

  return { reap, skipped };
}

/**
 * Best-effort "is this pid still the process we recorded", by asking the OS what it is running.
 *
 * FAILS CLOSED on every uncertainty: an unreadable command line, an unsupported platform, a probe
 * that errors. That means an orphan we cannot identify is LEFT RUNNING and reported rather than
 * killed. The asymmetry is deliberate -- a leaked agent is visible, annoying and recoverable, and
 * ending an unrelated process because a pid was recycled is none of those.
 *
 * A record written before launchers were tracked has no launcher to match, and is therefore never
 * reaped. That is the same trade: it is the one case where we genuinely cannot tell.
 */
/**
 * How far the OS-reported start time may sit from the one this process recorded.
 *
 * The record is stamped here just after spawn and the OS reports the child's own creation, so the two
 * differ by however long the spawn took. Seconds is generous for that, and still refuses a pid the OS
 * reused minutes later -- which is the case this exists for.
 */
export const START_TIME_TOLERANCE_MS = 30_000;

/** Ticks per second procfs reports `starttime` in. USER_HZ is 100 on Linux and procfs is fixed to it. */
export const LINUX_USER_HZ = 100;

/**
 * A Linux process's start time in epoch ms, from procfs, or null when it cannot be read.
 *
 * TWO FILES, because neither answers alone. `/proc/<pid>/stat` field 22 is the process's start in
 * clock ticks SINCE BOOT, and `/proc/stat`'s `btime` line is when that boot was, in epoch seconds.
 *
 * THE COMM FIELD IS THE TRAP. Field 2 is the executable name in parentheses and may contain both
 * spaces and parentheses, so splitting the line on whitespace mis-numbers every field after it. The
 * only safe split is after the LAST `)`, which is what this does.
 *
 * Pure over the two file contents, so it is tested on any platform rather than only where it runs.
 */
export function linuxProcessStartedAt(pid, readFile) {
  let statLine;
  let bootText;
  try {
    statLine = String(readFile(`/proc/${pid}/stat`, "utf8"));
    bootText = String(readFile("/proc/stat", "utf8"));
  } catch {
    return null;
  }
  const close = statLine.lastIndexOf(")");
  if (close === -1) return null;
  // After `) ` the next token is field 3 (state), so field 22 sits at index 19.
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks) || ticks < 0) return null;

  const btime = /^btime\s+(\d+)/m.exec(bootText);
  if (!btime) return null;
  const bootEpochSeconds = Number(btime[1]);
  if (!Number.isFinite(bootEpochSeconds) || bootEpochSeconds <= 0) return null;

  return (bootEpochSeconds + ticks / LINUX_USER_HZ) * 1000;
}

/** The process's real start time in epoch ms, or null when this host cannot say. */
function processStartedAt(pid, { platform, run, readFile = readFileSync, statOf = null }) {
  try {
    if (platform === "linux") {
      // FIELD 22 OF /proc/<pid>/stat, NOT THE DIRECTORY'S ctime (R9-M7, external review 2026-09-06).
      //
      // This read `statSync('/proc/<pid>').ctimeMs` and called it "the DIRECTORY's creation, which
      // is the process's". procfs does not stamp its inodes that way: the reviewer measured pid 1's
      // ctime as 440,701 SECONDS before the machine's own boot time. Every comparison against
      // START_TIME_TOLERANCE_MS therefore failed, and this probe fails SAFE -- so a reused pid was
      // never refused and orphans leaked with nothing reported.
      //
      // It was exercised by no test either: every reaper test injects `startedAtOf`, so six of them
      // passed for the wrong reason. `linuxProcessStartedAt` below is a pure parser, and it is
      // tested directly against real /proc text on any platform.
      return linuxProcessStartedAt(pid, readFile);
    }
    if (platform === "win32") {
      const res = run(
        "powershell.exe",
        ["-NoProfile", "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const at = Date.parse(String(res.stdout ?? "").trim());
      return Number.isNaN(at) ? null : at;
    }
  } catch {
    return null;
  }
  return null;
}

export function defaultVerify(entry, { platform = process.platform, run = spawnSync, startedAtOf = null } = {}) {
  const launcher = String(entry?.launcher ?? "").trim();
  if (!launcher) return false;

  let cmdline = "";
  try {
    if (platform === "linux") {
      // NUL-separated argv; the separator only matters for splitting, and we are substring-matching.
      cmdline = readFileSync(`/proc/${entry.pid}/cmdline`, "utf8");
    } else if (platform === "win32") {
      const res = run(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${entry.pid}").CommandLine`],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      cmdline = String(res.stdout ?? "");
    } else {
      // macOS and anything else: no probe implemented, so no permission to kill.
      return false;
    }
  } catch {
    return false;
  }

  // THE LAUNCHER IS NOT ENOUGH ON ITS OWN, and this is the half Round 7 left open (external review,
  // Round 8). Every Claude agent on a host shares ONE launcher path, so a pid recycled onto a SIBLING
  // agent matches it perfectly -- and the reaper kills a working agent believing it is collecting its
  // own orphan.
  //
  // `startedAt` is the discriminating fact and it is already in the record: a pid the OS handed to
  // something else necessarily started AFTER we wrote ours down. Both halves must hold -- the
  // launcher says "this is the kind of thing I started", the start time says "and it is the SAME one".
  //
  // AN UNREADABLE START TIME MEANS NO KILL, which is this function's existing rule for a platform
  // with no probe, applied one level down. On a kill path an unanswerable question is not a yes: the
  // cost of refusing is a leaked orphan the doctor reports, and the cost of being wrong the other way
  // is a working agent that nothing recovers.
  const recorded = Number(entry?.startedAt ?? 0);
  if (!recorded) return false;
  const actual = startedAtOf
    ? startedAtOf(entry.pid)
    : processStartedAt(entry.pid, { platform, run });
  if (!actual) return false;
  if (Math.abs(actual - recorded) > START_TIME_TOLERANCE_MS) return false;

  if (!cmdline.trim()) return false;
  // Compared with separators normalised, because a launcher recorded with forward slashes is reported
  // by Windows with backslashes and neither spelling is wrong.
  const flat = (value) => value.split(String.fromCharCode(92)).join("/").toLowerCase();
  return flat(cmdline).includes(flat(launcher));
}
