// Recovered records have no live ChildProcess handle. Admission here never manufactures #13's live-child custody.
import { defaultVerify } from './orphan-reap.mjs';
import { isSelfProtected, STOP_EXIT_WAIT_MS } from './kill-tree.mjs';
import { heldKill } from './held-process-tree.mjs';
import { observedBirth, validBirth, originalBirthState, heldBirthMatches } from './process-birth.mjs';
import { endObservedProcessGroup } from './process-group-termination.mjs';

const unknown = problem => ({ state: 'unknown', problem });
const gone = scope => ({ state: 'gone', scope });
const HELD_BUDGET_MS = 15000;

function recordedPosixGroup(entry) {
  const scope = entry?.groupScope;
  return scope?.kind === 'posix-process-group' && Object.keys(scope).length === 2
    && Number.isSafeInteger(entry?.pid) && entry.pid > 1 && scope.pgid === entry.pid;
}

export class RecoveredProcessTermination {
  #platform; #identity; #signal; #held; #now; #wait; #budget; #self; #parent;
  constructor({ platform = process.platform, identity, signal = process.kill, held = heldKill,
    now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs = STOP_EXIT_WAIT_MS, selfPid = process.pid, parentPid = process.ppid } = {}) {
    this.#platform = platform; this.#identity = identity; this.#signal = signal; this.#held = held;
    this.#now = now; this.#wait = wait; this.#budget = timeoutMs; this.#self = selfPid; this.#parent = parentPid;
  }
  #protected(pid) { return !Number.isSafeInteger(pid) || pid <= 1 || isSelfProtected(pid, this.#self, this.#parent); }
  groupState(entry) {
    if (this.#platform !== 'linux' || this.#protected(entry?.pid) || !recordedPosixGroup(entry)) return 'unknown';
    try { this.#signal(-entry.pid, 0); return 'present'; }
    catch (error) { return error?.code === 'ESRCH' ? 'gone' : 'unknown'; }
  }
  async #observe(pid, groups = false) {
    try { return (await this.#identity.probe([pid], { groups })).get(pid); }
    catch { return undefined; }
  }

  /** Root absence cannot erase a possibly surviving tree. A recorded group needs separate positive absence. */
  absentRoot(entry) {
    return recordedPosixGroup(entry) && this.groupState(entry) === 'gone'
      ? gone('recorded-posix-group')
      : unknown(recordedPosixGroup(entry) ? 'unverified group: root gone, group custody cannot be reacquired' : 'root gone; descendant cleanup cannot be verified');
  }

  async child(entry, answer) {
    if (this.#protected(entry?.pid)) return unknown('protected or invalid recorded process');
    if (this.#platform === 'linux') answer = await this.#observe(entry.pid, true);
    if (answer?.alive === false) return this.absentRoot(entry);
    if (!defaultVerify(entry, { platform: this.#platform, answer })) return unknown('recorded child identity is unknown or mismatched');
    if (this.#platform === 'win32') return this.#heldTree(entry.pid, observedBirth(entry.pid, answer, this.#platform));
    if (this.#platform !== 'linux' || !recordedPosixGroup(entry) || answer.groupId !== entry.pid)
      return unknown('recorded group ownership/membership is unverified');

    // Acquire only while the original root and its owning-spawn group agree. Numeric custody is limited
    // to this bounded attempt; it is not a held OS handle or proof across an unobserved reuse gap.
    let retired = false;
    const observe = () => {
      if (retired) return 'gone';
      const state = this.groupState(entry);
      if (state === 'gone') retired = true;
      return state;
    };
    const send = signal => {
      if (retired) return;
      try { this.#signal(-entry.pid, signal); }
      catch (error) { if (error?.code === 'ESRCH') retired = true; else throw error; }
    };
    try {
      await endObservedProcessGroup({ observe, send, canBegin: () => true,
        failure: state => Error(`recorded group cleanup ${state}`), now: this.#now, wait: this.#wait, timeoutMs: this.#budget });
      return gone('recorded-posix-group');
    } catch (error) { return unknown(`unverified group: ${error?.message || error}`); }
  }

  async #heldTree(pid, birth) {
    if (!validBirth(birth, pid)) return unknown('no observed birth for the held root');
    try {
      await this.#held(pid, { stillOurs: held => heldBirthMatches(birth, held), timeoutMs: HELD_BUDGET_MS });
      return gone('reachable-held-tree');
    } catch (error) { return unknown(`reachable-tree cleanup unconfirmed: ${error?.message || error}`); }
  }

  /** The caller captured this specific shape-checked incumbent at takeover start, including legacy health. */
  async incumbent(birth) {
    if (!validBirth(birth) || this.#protected(birth.pid)) return unknown('incumbent birth is not usable');
    if (this.#platform === 'win32') return this.#heldTree(birth.pid, birth);
    if (this.#platform !== 'linux' || !Number.isFinite(this.#budget) || this.#budget < 0) return unknown('incumbent termination unavailable');
    try {
      const started = this.#now();
      if (!Number.isFinite(started)) return unknown('incumbent clock unavailable');
      const deadline = started + this.#budget, grace = started + this.#budget / 2;
      for (const [signal, end] of [['SIGTERM', grace], ['SIGKILL', deadline]]) {
        const state = originalBirthState(birth, await this.#observe(birth.pid), this.#platform);
        if (state === 'gone') return gone('incumbent-root');
        if (state !== 'present') return unknown('original incumbent identity became unknown');
        try { this.#signal(birth.pid, signal); }
        catch (error) { if (error?.code === 'ESRCH') return gone('incumbent-root'); throw error; }
        for (let polls = 0; polls < 1000; polls++) {
          const after = originalBirthState(birth, await this.#observe(birth.pid), this.#platform);
          if (after === 'gone') return gone('incumbent-root');
          if (after !== 'present') return unknown('original incumbent identity became unknown');
          const clock = this.#now(), remaining = end - clock;
          if (!Number.isFinite(clock)) return unknown('incumbent clock unavailable');
          if (!(remaining > 0)) break;
          await this.#wait(Math.min(10, remaining));
          if (polls === 999) return unknown('incumbent clock did not advance');
        }
      }
      return unknown('original incumbent remains alive after TERM/KILL budget');
    } catch (error) { return unknown(`incumbent cleanup unconfirmed: ${error?.message || error}`); }
  }
}
