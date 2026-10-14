// Every process on this host, as {pid, ppid, commandLine}: one question, for a doctor row that has to
// find processes by what they run rather than by a pid it already holds.
//
// `process-probe.mjs` answers about pids it is GIVEN, which is the cheap question the lifetimes ask.
// The `managed-orphans` row (moved here from `aify-comms doctor` in 0.9.7) asks the other one: which
// processes on this host are running a given program, whoever started them.
//
// IT THROWS RATHER THAN ANSWERING EMPTY. A listing that failed, timed out or printed nothing is not a
// host with no processes, and the caller turns a throw into "the process table could not be read". The
// copy this was ported from returned [] for both, and that conflation hid a broken default for a whole
// release (aify-comms `b57abc9e`).

import { spawnSync } from "node:child_process";

const LIST_TIMEOUT_MS = 10_000;

// UTF-8 OUT OF POWERSHELL: a command line is matched against paths, and OEM-encoded output mangles a
// non-ASCII profile path so the match silently misses.
const WINDOWS_LISTING = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; "
  + "$OutputEncoding = [System.Text.Encoding]::UTF8; "
  + "Get-CimInstance Win32_Process | "
  + "ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }";

/** `PID\tPPID\tCOMMANDLINE` lines, as the Windows listing prints them. PURE. */
export function parseWindowsListing(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) return null;
      const pid = Number(parts[0].trim());
      const ppid = Number(parts[1].trim());
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, ppid: Number.isInteger(ppid) ? ppid : 0, commandLine: parts.slice(2).join("\t") };
    })
    .filter(Boolean);
}

/** `ps -eo pid=,ppid=,args=` lines. PURE. */
export function parsePosixListing(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3] } : null;
    })
    .filter(Boolean);
}

/**
 * @param {{platform?: string, run?: typeof spawnSync}} [deps]
 * @returns {{pid: number, ppid: number, commandLine: string}[]}
 * @throws when the listing failed, timed out or printed nothing
 */
export function listHostProcesses({ platform = process.platform, run = spawnSync } = {}) {
  const windows = platform === "win32";
  const result = windows
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LISTING],
      { encoding: "utf8", windowsHide: true, timeout: LIST_TIMEOUT_MS })
    : run("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: LIST_TIMEOUT_MS });
  if (!result || result.error || result.status !== 0 || !String(result.stdout || "").trim()) {
    throw new Error(`process listing failed: ${result?.error?.code || result?.error?.message || `status ${result?.status}`}`);
  }
  return windows ? parseWindowsListing(result.stdout) : parsePosixListing(result.stdout);
}
