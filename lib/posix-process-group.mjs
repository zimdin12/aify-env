// Custody of a group created by this process's detached POSIX spawn. Never construct from a recovered PID.
import { isSelfProtected } from './kill-tree.mjs';
import { endObservedProcessGroup } from './process-group-termination.mjs';
const STATE = Object.freeze({ present: 'present', gone: 'gone', unknown: 'unknown' });
const KIND = 'owned-posix-group';

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
  #perform({ timeoutMs, phase, force }) {
    return endObservedProcessGroup({ timeoutMs, phase, force,
      observe: () => this.observe(), send: name => this.#send(name), canBegin: () => !this.#exitSeen,
      failure: state => new GroupEndError(this.#pid, state), now: this.#now, wait: this.#wait });
  }
  #send(name) {
    if (this.#gone) return;
    try { this.#signal(-this.#pid, name); }
    catch (error) {
      if (error?.code === 'ESRCH') { this.#gone = true; return; }
      throw new GroupEndError(this.#pid, STATE.unknown, error);
    }
  }
}

/** Reject on uncertainty; an attempted signal or a root's close is never a cleanup certificate. */
export function endPosixGroup(group, options) {
  if (!(group instanceof PosixProcessGroup)) return Promise.reject(new TypeError('an owned POSIX process group is required'));
  return group.end(options);
}
