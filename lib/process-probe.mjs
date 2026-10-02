// What the OS says about a set of pids, in ONE question (0.9 plan P0 C4; the answer `verifyLifetime` reads).
//
// ONE POWERSHELL PER SWEEP, NEVER ONE PER PID. A PowerShell and a CIM query cost about 0.7 s of CPU on Windows, and
// a per-agent watch that asked every fifth second spent 1.5 cores of a 16-agent host doing it (aify-wrapper b20f405,
// measured 2026-10-02). So this asks once for every pid given, and the caller decides how often: on first sight of a
// record, then rarely. Between probes `process.kill(pid, 0)` says whether a pid is alive at no cost, and a pinned
// creation time is what tells a reused pid apart when the probe does run.
//
// THREE ANSWERS PER PID, matching `verifyLifetime`'s probe:
//   alive: true   with createdAtUs and commandLine, as the OS reported them
//   alive: false  the probe ran and the OS has no such process
//   alive: null   the probe could not answer: it failed, timed out, printed what this cannot parse, or the platform
//                 has no probe. Every pid of a failed probe is null, never false: a probe that fails says nothing.
//
// Windows only. Linux reports start time in clock ticks (10 ms), too coarse for C4's strictly-before-the-write rule at
// microseconds, so it answers null until a finer source is chosen.

import { spawnSync } from "node:child_process";

import { isoToEpochMicros } from "./resident-lifetimes.mjs";

const PROBE_TIMEOUT_MS = 15_000;

/**
 * @param {number[]} pids
 * @param {{platform?: string, run?: Function}} [io]
 * @returns {Map<number, {alive: boolean|null, createdAtUs: number|null, commandLine: string|null}>}
 */
export function probeProcesses(pids, { platform = process.platform, run = spawnSync } = {}) {
  const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const unanswered = () => new Map(wanted.map((pid) => [pid, { alive: null, createdAtUs: null, commandLine: null }]));
  if (!wanted.length) return new Map();
  if (platform !== "win32") return unanswered();
  const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
  // Progress records also go to stderr when it is redirected, and would read as an error, so progress is off.
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object {
    [pscustomobject]@{ pid = $_.ProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }); cmd = $_.CommandLine } })`;
  let rows;
  try {
    const res = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: PROBE_TIMEOUT_MS });
    // A query that reported an error answered nothing, even with an exit of 0 and `[]` on stdout: its empty list is
    // not the OS saying the pids are gone (review of 0c18f91). The script also stops on its first error.
    if (res.error || res.status !== 0 || String(res.stderr ?? "").trim()) return unanswered();
    rows = JSON.parse(String(res.stdout ?? "").trim());
    if (!Array.isArray(rows)) return unanswered();
  } catch {
    return unanswered();
  }
  const answers = new Map(wanted.map((pid) => [pid, { alive: false, createdAtUs: null, commandLine: null }]));
  for (const row of rows) {
    if (!answers.has(row?.pid)) continue;
    answers.set(row.pid, {
      alive: true,
      createdAtUs: typeof row.created === "string" ? isoToEpochMicros(row.created) : null,
      commandLine: typeof row.cmd === "string" ? row.cmd : null,
    });
  }
  return answers;
}
