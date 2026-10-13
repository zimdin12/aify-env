// What the OS says about a set of pids, in ONE question (0.9 plan P0 C4; the answer `verifyLifetime` reads).
//
// ONE POWERSHELL PER SWEEP, NEVER ONE PER PID. A PowerShell and a CIM query cost about 0.7 s of CPU on Windows, and
// a per-agent watch that asked every fifth second spent 1.5 cores of a 16-agent host doing it (aify-wrapper b20f405,
// measured 2026-10-02). So this asks once for every pid given: on first sight of a record, then at most once per
// PROBE_REUSE_MS per pid while something keeps asking. Between probes `process.kill(pid, 0)` says whether a pid is alive at no cost, and a pinned
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

import { execFile, spawnSync } from "node:child_process";

import { processState } from "./agent-definitions.mjs";
import { isoToEpochMicros } from "./resident-lifetimes.mjs";

const PROBE_TIMEOUT_MS = 15_000;
const UNANSWERED = Object.freeze({ alive: null, createdAtUs: null, commandLine: null });
const GONE = Object.freeze({ alive: false, createdAtUs: null, commandLine: null });

const wantedPids = (pids) => [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);

function command(wanted) {
  const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
  // Progress records also go to stderr when it is redirected, and would read as an error, so progress is off.
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object {
    [pscustomobject]@{ pid = $_.ProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }); cmd = $_.CommandLine } })`;
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/** The answers one finished PowerShell run gives for `wanted`. PURE. */
function answersFrom(res, wanted) {
  const unanswered = () => new Map(wanted.map((pid) => [pid, UNANSWERED]));
  let rows;
  try {
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

/**
 * @param {number[]} pids
 * @param {{platform?: string, run?: Function}} [io]
 * @returns {Map<number, {alive: boolean|null, createdAtUs: number|null, commandLine: string|null}>}
 */
export function probeProcesses(pids, { platform = process.platform, run = spawnSync } = {}) {
  const wanted = wantedPids(pids);
  if (!wanted.length) return new Map();
  if (platform !== "win32") return new Map(wanted.map((pid) => [pid, UNANSWERED]));
  let res;
  try {
    res = run("powershell.exe", command(wanted), { encoding: "utf8", windowsHide: true, timeout: PROBE_TIMEOUT_MS });
  } catch (error) {
    res = { error };
  }
  return answersFrom(res, wanted);
}

/** `probeProcesses`, without holding the event loop for the ~1.2 s a PowerShell and a CIM query take. */
export async function probeProcessesAsync(pids, { platform = process.platform, run = execFile } = {}) {
  const wanted = wantedPids(pids);
  if (!wanted.length) return new Map();
  if (platform !== "win32") return new Map(wanted.map((pid) => [pid, UNANSWERED]));
  const res = await new Promise((resolve) => {
    try {
      run("powershell.exe", command(wanted), { encoding: "utf8", windowsHide: true, timeout: PROBE_TIMEOUT_MS },
        (error, stdout, stderr) => resolve({ error: error ?? undefined, status: error ? 1 : 0, stdout, stderr }));
    } catch (error) {
      resolve({ error });
    }
  });
  return answersFrom(res, wanted);
}

//: How long one probe's answer stands for its pids. Every Claude tool call sends a turn event, and each used to run a
//: blocking probe, freezing the daemon (and every herdr pane on it) for ~1.4 s about every 10 s (measured 2026-10-13).
//: Signal 0 answers liveness inside the window, so the window bounds only how long a dead agent's REUSED pid can pass
//: for it. 5 s re-ran PowerShell about every 5 s while any agent worked (~0.7 s CPU each, review of 0.9.2); 30 s is a
//: sixth of that. ponytail: a native creation-time read (koffi) would drop the re-probe entirely; do that when this shows.
export const PROBE_REUSE_MS = 30_000;

/**
 * What the OS says about pids, without blocking the daemon while it serves.
 *
 * Until `serve()` the answers are probed synchronously: that is boot, before anything is served, and boot restores
 * turns by them. After it, a pid probed within PROBE_REUSE_MS gets that answer; any other starts ONE background
 * probe (concurrent asks join it) and is answered meanwhile by signal 0, as this file's header says the time between
 * probes is: a pid the OS says is gone is gone, one still alive keeps its last answer (its pinned creation time is
 * checked again when the probe lands), and one never answered or not provably alive is unanswered. Signal 0 is asked on
 * every answer, inside the window too, so an exit is never hidden by a reused answer. `onUpdate` runs
 * after each probe lands, so the caller can judge again with the fresh answers.
 */
export class ProcessProbeCache {
  #probe;
  #probeSync;
  #state;
  #nowMs;
  #serving = false;
  #kept = new Map();
  #queued = new Set();
  #asking = new Set();
  #inFlight = null;
  onUpdate = () => {};

  constructor({ probe = probeProcessesAsync, probeSync = probeProcesses, state = processState, nowMs = Date.now } = {}) {
    this.#probe = probe;
    this.#probeSync = probeSync;
    this.#state = state;
    this.#nowMs = nowMs;
  }

  /** Boot is over: from now on nothing here blocks. */
  serve() {
    this.#serving = true;
  }

  /**
   * @param {{writtenAtMs?: Map<number, number>}} [options]  per pid, when the record being judged was written: an answer
   *   probed before then is not reused for it.
   * @returns {Map<number, {alive: boolean|null, createdAtUs: number|null, commandLine: string|null}>}
   */
  answers(pids, { writtenAtMs = new Map() } = {}) {
    const wanted = wantedPids(pids);
    if (!this.#serving) {
      const startedAtMs = this.#nowMs();
      const fresh = this.#probeSync(wanted);
      this.#keep(fresh, startedAtMs, this.#nowMs());
      return fresh;
    }
    const now = this.#nowMs();
    const answers = new Map();
    const stale = [];
    for (const pid of wanted) {
      const kept = this.#kept.get(pid);
      // An answer older than the record it would judge describes whatever held the pid before that record existed.
      // STRICTLY LATER, BY THE PROBE'S START: the write is known to the millisecond, so a probe started in that same
      // millisecond may predate it, and an answer is as old as the moment its snapshot was taken, not when it landed.
      const written = writtenAtMs.get(pid) ?? -Infinity;
      const current = kept?.answer && kept.atMs > written;
      if (current && now - kept.atMs <= PROBE_REUSE_MS) {
        // Reused only while signal 0 agrees with it: an exit inside the window is seen at once, and a kept GONE on a pid
        // that is alive again (a reuse) or a kept answer signal 0 cannot confirm is unanswered until the next probe,
        // never an old absence a caller would turn into a removal (review of 3e58c72).
        answers.set(pid, this.#between(pid, kept.answer));
        continue;
      }
      // A pid tried within the window waits it out, answered or not: a probe that keeps failing is not asked again
      // and again (the answer-then-judge-again loop through `onUpdate` would never end). PACED FROM WHEN THE LAST PROBE
      // LANDED, not when it started: a probe slower than the window would otherwise land already due, and `onUpdate`
      // would ask again at once, for ever (whole-diff review of 0.9.2). The answer's age stays its start.
      // A record written since the last try is asked about at once: its first sight should not wait out the window.
      if (!kept || now - kept.landedAtMs > PROBE_REUSE_MS || kept.triedAtMs <= written) stale.push(pid);
      answers.set(pid, this.#between(pid, current ? kept.answer : null));
    }
    if (stale.length) this.refresh(stale).catch(() => {});
    return answers;
  }

  /** Probe `pids` in the background; asks made while one runs join the next. Resolves once they are answered. */
  refresh(pids) {
    for (const pid of wantedPids(pids)) if (!this.#asking.has(pid)) this.#queued.add(pid);
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = (async () => {
      try {
        while (this.#queued.size) {
          this.#asking = new Set(this.#queued);
          this.#queued.clear();
          const startedAtMs = this.#nowMs();
          const answered = await this.#probe([...this.#asking]);
          this.#keep(answered, startedAtMs, this.#nowMs());
          this.#asking = new Set();
          this.onUpdate();
        }
      } finally {
        this.#asking = new Set();
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }

  #between(pid, last) {
    const state = this.#state(pid);
    if (state === "gone") return GONE;
    return state === "alive" && last?.alive === true ? last : UNANSWERED;
  }

  /** `startedAtMs` is when the probe asked: its answer is that old, however late it arrives. `landedAtMs` paces the next. */
  #keep(answers, startedAtMs, landedAtMs) {
    for (const [pid, answer] of answers) {
      const kept = this.#kept.get(pid) ?? { answer: null, atMs: 0, triedAtMs: 0, landedAtMs: 0 };
      kept.triedAtMs = startedAtMs;
      kept.landedAtMs = landedAtMs;
      // An unanswered probe says nothing, so it never replaces a real answer.
      if (answer.alive !== null) Object.assign(kept, { answer, atMs: startedAtMs });
      this.#kept.set(pid, kept);
    }
  }
}
