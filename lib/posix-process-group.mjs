// Custody of a group created by this process's detached POSIX spawn. Never construct from a recovered PID.
import { isSelfProtected, STOP_EXIT_WAIT_MS } from './kill-tree.mjs';
const STATE = Object.freeze({ present: 'present', gone: 'gone', unknown: 'unknown' });
const KIND = 'owned-posix-group';
const POLL_MS = 10;

class GroupEndError extends Error {
  constructor(pid, state, cause) {
    super(`execution-unknown: POSIX group ${pid} ${state === STATE.present ? 'is still present' : 'could not be confirmed absent'}`, { cause });
    this.state = state;
  }
}

/** Structured refusal only: legacy Windows/PTY stopped:false retains its existing PID verification policy. */
export function isPosixGroupRefusal(answer) {
  const group = answer?.groupCleanup;
  return answer?.stopped === false && group?.kind === KIND
    && (group.state === STATE.present || group.state === STATE.unknown);
}

export class PosixProcessGroup {
  #pid; #valid; #signal; #now; #wait; #defer; #exitSeen; #gone = false; #attempt = null;
  constructor({ child, detached, platform = process.platform, signal = process.kill,
    now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    defer = () => new Promise(resolve => setImmediate(resolve)), selfPid = process.pid, parentPid = process.ppid }) {
    this.#pid = child?.pid;
    this.#valid = typeof platform === 'string' && platform !== '' && platform !== 'win32' && detached === true
      && Number.isSafeInteger(this.#pid) && this.#pid > 0 && !isSelfProtected(this.#pid, selfPid, parentPid)
      && typeof child?.once === 'function' && typeof signal === 'function' && typeof now === 'function' && typeof wait === 'function' && typeof defer === 'function';
    this.#signal = signal; this.#now = now; this.#wait = wait; this.#defer = defer;
    this.#exitSeen = child?.exitCode != null || child?.signalCode != null;
    child?.once?.('exit', () => { this.#exitSeen = true; });
  }
  get pid() { return this.#pid; }
  /** ESRCH retires custody permanently: a later numeric reuse must never be probed or signalled through it. */
  observe() {
    if (this.#gone) return STATE.gone;
    if (!this.#valid) return STATE.unknown;
    try { this.#signal(-this.#pid, 0); return STATE.present; }
    catch (error) {
      if (error?.code === 'ESRCH') { this.#gone = true; return STATE.gone; }
      return STATE.unknown;
    }
  }
  refusal(error) {
    const state = error instanceof GroupEndError ? error.state : STATE.unknown;
    return { stopped: false, problem: error instanceof GroupEndError ? error.message : `execution-unknown: POSIX group ${this.#pid}: ${error?.message || 'cleanup unconfirmed'}`,
      groupCleanup: { kind: KIND, pid: this.#pid, state } };
  }
  end(options = {}) {
    if (this.#attempt) return this.#attempt;
    // Run after pending child exit callbacks: an exit-unseen witness in another callback is not enough.
    const attempt = Promise.resolve().then(async () => {
      if (!this.#valid) throw new GroupEndError(this.#pid, STATE.unknown);
      await this.#defer();
      return this.#perform(options);
    });
    this.#attempt = attempt;
    attempt.then(() => { this.#attempt = null; }, () => { this.#attempt = null; });
    return attempt;
  }
  async #perform({ timeoutMs = STOP_EXIT_WAIT_MS, phase = () => {}, force = false }) {
    const initial = this.observe();
    if (initial === STATE.gone) return;
    if (initial !== STATE.present || this.#exitSeen) throw new GroupEndError(this.#pid, STATE.unknown);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new GroupEndError(this.#pid, STATE.unknown);
    const started = this.#now();
    if (!Number.isFinite(started)) throw new GroupEndError(this.#pid, STATE.unknown);
    const graceEnds = started + timeoutMs / 2, deadline = started + timeoutMs;
    let state;
    if (force !== true) {
      phase('group-term');
      this.#send('SIGTERM');
      state = await this.#until(graceEnds);
      if (state === STATE.gone) return;
      if (state !== STATE.present) throw new GroupEndError(this.#pid, STATE.unknown);
    }
    phase('group-kill');
    this.#send('SIGKILL');
    state = await this.#until(deadline);
    if (state !== STATE.gone) throw new GroupEndError(this.#pid, state);
  }
  #send(name) {
    if (this.#gone) return;
    try { this.#signal(-this.#pid, name); }
    catch (error) {
      if (error?.code === 'ESRCH') { this.#gone = true; return; }
      throw new GroupEndError(this.#pid, STATE.unknown, error);
    }
  }
  async #until(deadline) {
    for (;;) {
      const state = this.observe();
      if (state !== STATE.present) return state;
      const now = this.#now();
      if (!Number.isFinite(now)) return STATE.unknown;
      const remaining = deadline - now;
      if (!(remaining > 0)) return STATE.present;
      await this.#wait(Math.min(POLL_MS, remaining));
    }
  }
}

/** Reject on uncertainty; an attempted signal or a root's close is never a cleanup certificate. */
export function endPosixGroup(group, options) {
  if (!(group instanceof PosixProcessGroup)) return Promise.reject(new TypeError('an owned POSIX process group is required'));
  return group.end(options);
}
