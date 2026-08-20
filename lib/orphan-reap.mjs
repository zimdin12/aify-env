import { readFileSync } from "node:fs";
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
 * @param {Array<{id: string, pid: number, service: string, startedAt: number}>} entries
 * @param {{isAlive: (pid: number) => boolean, verify: (entry: object) => boolean}} probes
 *   `verify` answers "is this pid still the process we recorded". How that is established is platform
 *   work and belongs to the caller; the decision does not change with the technique.
 * @returns {{reap: object[], skipped: Array<{entry: object, reason: string}>}}
 */
export function planOrphanReap(entries, { isAlive, verify }) {
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
export function defaultVerify(entry, { platform = process.platform, run = spawnSync } = {}) {
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

  if (!cmdline.trim()) return false;
  // Compared with separators normalised, because a launcher recorded with forward slashes is reported
  // by Windows with backslashes and neither spelling is wrong.
  const flat = (value) => value.split(String.fromCharCode(92)).join("/").toLowerCase();
  return flat(cmdline).includes(flat(launcher));
}
