// One spawned child's stop custody. The child object, not a recovered pid-only record, owns the exit witness.
// The same control id replays its attempt; a fresh explicit request may try another kill.
import { waitBounded } from './kill-tree.mjs';
import { endPosixGroup } from './posix-process-group.mjs';

const complete = () => ({ stopped: true, problem: '' });
const unknown = problem => ({ stopped: false, problem: `execution-unknown: ${problem}` });
export class RunnerStop {
  #child; #pid; #exit; #ended; #io; #group; #attempts = new Map(); #requested = false;
  #handoff; #pendingAttempt = null;
  constructor({ child, exit, ended, io, group = null, handoff = null }) {
    this.#child = child; this.#pid = child.pid; this.#exit = exit; this.#ended = ended; this.#io = io; this.#group = group;
    this.#handoff = handoff;
  }
  get ownsGroup() { return this.#group !== null; }
  /** Root exit/close is not permission to release a group whose absence is still unproved. */
  canRelease() { return this.#group === null || this.#group.observe() === 'gone'; }
  /** Whether anyone asked for this stop; the runner then records the child's end as `stopped` (a recording policy). */
  get requested() { return this.#requested; }
  run({ requestId, phase = () => {}, budgetMs = this.#io.exitWaitMs } = {}) {
    this.#requested = true;
    if (this.#handoff && this.#pendingAttempt) return this.#pendingAttempt;
    if (requestId && this.#attempts.has(requestId)) return this.#attempts.get(requestId);
    let resolve, reject;
    const attempt = new Promise((yes, no) => { resolve = yes; reject = no; });
    if (requestId) this.#attempts.set(requestId, attempt);
    if (this.#handoff) this.#pendingAttempt = attempt;
    // Enter synchronously, after publishing replay custody: shutdown names each stop before entering it.
    (this.#handoff ? this.#stopOnHandoff({ requestId, phase, budgetMs }) : this.#perform(phase, budgetMs)).then(resolve, reject);
    return attempt;
  }
  async #stopOnHandoff({ requestId, phase, budgetMs }) {
    const deadline = Symbol('stop deadline'), started = Date.now();
    let timer, transferred = false;
    phase('spawn-wait');
    // This continuation remains owned after a timeout; late success must still be stopped.
    const work = this.#handoff.then(stop => {
      transferred = true;
      return stop ? stop({ requestId, phase, budgetMs: Math.max(0, budgetMs - (Date.now() - started)) }) : complete();
    });
    let answer;
    try {
      answer = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(deadline), budgetMs); })]);
    } finally { clearTimeout(timer); }
    if (answer !== deadline) return answer;
    if (!transferred) {
      phase('child-kill');
      try { this.#child.kill(); } catch { /* An attempt is not a confirmed spawn outcome or death. */ }
    }
    // Keep a rejected late stop observed even after its caller has left the wait.
    work.catch(() => {});
    phase('done');
    return unknown('spawn outcome or stop handoff did not confirm within the stop budget');
  }
  async #perform(phase, budgetMs) {
    if (this.#group !== null) {
      let answer;
      try { await endPosixGroup(this.#group, { timeoutMs: budgetMs, phase }); answer = complete(); }
      catch (error) { answer = this.#group.refusal(error); }
      phase('done');
      return answer;
    }
    if (this.#ended()) return complete();
    const pid = this.#pid, alive = this.#io.isAlive(pid);
    // Never ask ConPTY to attach to a pid already gone; it could now be a sibling's console.
    if (alive !== true && alive !== false) throw Error(`pid ${pid} liveness unknown; stop refused`);
    if (alive === false) return complete();
    // Keep the established ConPTY order. Reversing it left descendants alive in the owned-process tests.
    // Announce BEFORE each call: a blocking console kill cannot print its phase afterwards.
    phase('console-kill');
    try { this.#child.kill(); } catch { /* A returned or throwing kill is not a death witness. */ }
    phase('tree-kill');
    await this.#io.killTree(pid);
    phase('exit-wait');
    await waitBounded(this.#exit, budgetMs);
    let after;
    try { after = this.#ended() ? false : this.#io.isAlive(pid); }
    catch { after = null; }
    phase('done');
    return after === false ? complete() : unknown(`pid ${pid} ${after === true
      ? 'is still running after the kill' : 'liveness could not be verified after the kill'}`);
  }
}
