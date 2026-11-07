// One spawned child's stop custody. The child object, not a recovered pid-only record, owns the exit witness.
// The same control id replays its attempt; a fresh explicit request may try another kill.
import { waitBounded } from './kill-tree.mjs';
import { endPosixGroup } from './posix-process-group.mjs';

const complete = () => ({ stopped: true, problem: '' });
const unknown = problem => ({ stopped: false, problem: `execution-unknown: ${problem}` });
export class RunnerStop {
  #child; #pid; #exit; #ended; #io; #group; #attempts = new Map(); #requested = false;
  constructor({ child, exit, ended, io, group = null }) {
    this.#child = child; this.#pid = child.pid; this.#exit = exit; this.#ended = ended; this.#io = io; this.#group = group;
  }
  get ownsGroup() { return this.#group !== null; }
  /** Root exit/close is not permission to release a group whose absence is still unproved. */
  canRelease() { return this.#group === null || this.#group.observe() === 'gone'; }
  /** Whether anyone asked for this stop; the runner then records the child's end as `stopped` (a recording policy). */
  get requested() { return this.#requested; }
  run({ requestId, phase = () => {} } = {}) {
    this.#requested = true;
    if (requestId && this.#attempts.has(requestId)) return this.#attempts.get(requestId);
    let resolve, reject;
    const attempt = new Promise((yes, no) => { resolve = yes; reject = no; });
    if (requestId) this.#attempts.set(requestId, attempt);
    // Enter synchronously, after publishing replay custody: shutdown names each stop before entering it.
    this.#perform(phase).then(resolve, reject);
    return attempt;
  }
  async #perform(phase) {
    if (this.#group !== null) {
      let answer;
      try { await endPosixGroup(this.#group, { timeoutMs: this.#io.exitWaitMs, phase }); answer = complete(); }
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
    await waitBounded(this.#exit, this.#io.exitWaitMs);
    let after;
    try { after = this.#ended() ? false : this.#io.isAlive(pid); }
    catch { after = null; }
    phase('done');
    return after === false ? complete() : unknown(`pid ${pid} ${after === true
      ? 'is still running after the kill' : 'liveness could not be verified after the kill'}`);
  }
}
