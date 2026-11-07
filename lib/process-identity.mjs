// One OS identity owner. The synchronous port preserves resident boot callers; recovery uses the async batch.
import { readFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { processState } from './definition-lock.mjs';
import { isoToEpochMicros } from './resident-lifetimes.mjs';
import { linuxStartTokenFromStat, sameLinuxStartToken } from './linux-process-token.mjs';

const TIMEOUT_MS = 15_000;
const UNKNOWN = Object.freeze({ alive: null, createdAtUs: null, commandLine: null });
const GONE = Object.freeze({ alive: false, createdAtUs: null, commandLine: null });
const LINUX_UNKNOWN = Object.freeze({ ...UNKNOWN, platform: 'linux', startToken: null });
const wantedPids = pids => [...new Set(Array.isArray(pids) ? pids : [])].filter(pid => Number.isSafeInteger(pid) && pid > 0);
const unanswered = (wanted, answer = UNKNOWN) => new Map(wanted.map(pid => [pid, answer]));

// proc stat field5, after the final comm ')'. Only returned when the same birth/group bracket both reads.
function groupIdFrom(stat) {
  if (typeof stat !== 'string') return null;
  const raw = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2];
  const group = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  return Number.isSafeInteger(group) ? group : null;
}

function windowsCommand(wanted) {
  const filter = wanted.map(pid => `ProcessId=${pid}`).join(' OR ');
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object {
    [pscustomobject]@{ pid = $_.ProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }); cmd = $_.CommandLine } })`;
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

function windowsAnswers(result, wanted) {
  let rows;
  try {
    if (result.error || result.status !== 0 || String(result.stderr ?? '').trim()) return unanswered(wanted);
    rows = JSON.parse(String(result.stdout ?? '').trim());
    if (!Array.isArray(rows)) return unanswered(wanted);
  } catch { return unanswered(wanted); }
  const answers = unanswered(wanted, GONE);
  for (const row of rows) {
    if (!answers.has(row?.pid)) continue;
    answers.set(row.pid, { alive: true,
      createdAtUs: typeof row.created === 'string' ? isoToEpochMicros(row.created) : null,
      commandLine: typeof row.cmd === 'string' ? row.cmd : null });
  }
  return answers;
}

export class ProcessIdentityProbe {
  #platform; #run; #runSync; #read; #state; #self;
  constructor({ platform = process.platform, run = execFile, runSync = spawnSync, readFile = readFileSync,
    state = processState, selfPid = process.pid } = {}) {
    this.#platform = platform; this.#run = run; this.#runSync = runSync; this.#read = readFile; this.#state = state; this.#self = selfPid;
  }

  async probe(pids, { groups = false } = {}) {
    const wanted = wantedPids(pids);
    if (!wanted.length) return new Map();
    if (this.#platform === 'linux') return this.#linux(wanted, { groups });
    if (this.#platform !== 'win32') return unanswered(wanted);
    const result = await new Promise(resolve => {
      try {
        this.#run('powershell.exe', windowsCommand(wanted), { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS },
          (error, stdout, stderr) => resolve({ error: error ?? undefined, status: error ? 1 : 0, stdout, stderr }));
      } catch (error) { resolve({ error }); }
    });
    return windowsAnswers(result, wanted);
  }

  probeSync(pids) {
    const wanted = wantedPids(pids);
    if (!wanted.length) return new Map();
    if (this.#platform === 'linux') return this.#linux(wanted);
    if (this.#platform !== 'win32') return unanswered(wanted);
    let result;
    try { result = this.#runSync('powershell.exe', windowsCommand(wanted), { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS }); }
    catch (error) { result = { error }; }
    return windowsAnswers(result, wanted);
  }

  /** Only the spawn owner calls this with its new child. Parent PID is checked; recovery never captures tokens. */
  captureChild(child) {
    if (this.#platform !== 'linux' || !Number.isSafeInteger(child?.pid) || child.pid <= 0 || child.exitCode != null) return null;
    try {
      const bootId = this.#read('/proc/sys/kernel/random/boot_id', 'utf8');
      return linuxStartTokenFromStat(this.#read(`/proc/${child.pid}/stat`, 'utf8'), bootId, child.pid, { parentPid: this.#self });
    } catch { return null; }
  }

  #linux(wanted, { groups = false } = {}) {
    let bootId;
    try { bootId = this.#read('/proc/sys/kernel/random/boot_id', 'utf8'); }
    catch { return unanswered(wanted, LINUX_UNKNOWN); }
    return new Map(wanted.map(pid => [pid, this.#linuxAnswer(pid, bootId, groups)]));
  }

  #linuxAnswer(pid, bootId, groups) {
    try {
      const stat = this.#read(`/proc/${pid}/stat`, 'utf8');
      const before = linuxStartTokenFromStat(stat, bootId, pid);
      if (!before) return LINUX_UNKNOWN;
      const commandLine = this.#read(`/proc/${pid}/cmdline`, 'utf8');
      const afterStat = this.#read(`/proc/${pid}/stat`, 'utf8');
      const after = linuxStartTokenFromStat(afterStat, bootId, pid);
      if (!sameLinuxStartToken(before, after, pid) || typeof commandLine !== 'string') return LINUX_UNKNOWN;
      const firstGroup = groupIdFrom(stat), lastGroup = groupIdFrom(afterStat);
      return { alive: true, createdAtUs: null, commandLine, platform: 'linux', startToken: after,
        ...(groups === true ? { groupId: firstGroup !== null && firstGroup === lastGroup ? lastGroup : null } : {}) };
    } catch (error) {
      // ENOENT alone may mean procfs hides a live process. Only the OS's ESRCH observation proves absence.
      try { if (error?.code === 'ENOENT' && this.#state(pid) === 'gone') return GONE; }
      catch { /* A failed existence probe proves nothing. */ }
      return LINUX_UNKNOWN;
    }
  }
}
