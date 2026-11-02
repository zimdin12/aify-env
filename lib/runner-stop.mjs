// One spawned child's stop custody. The child object, not a recovered pid-only record, owns the exit witness.
// The same control id replays its attempt; a fresh explicit request may try another kill.
import { waitBounded } from './kill-tree.mjs';

const complete = () => ({ stopped: true, problem: '' });
const unknown = problem => ({ stopped: false, problem: `execution-unknown: ${problem}` });
export class RunnerStop {
  #child; #pid; #exit; #ended; #io; #attempts = new Map();
  constructor({ child, exit, ended, io }) {
    this.#child = child; this.#pid = child.pid; this.#exit = exit; this.#ended = ended; this.#io = io;
  }
  run({ requestId, phase = () => {} } = {}) {
    if (requestId && this.#attempts.has(requestId)) return this.#attempts.get(requestId);
    let resolve, reject;
    const attempt = new Promise((yes, no) => { resolve = yes; reject = no; });
    if (requestId) this.#attempts.set(requestId, attempt);
    // Enter synchronously, after publishing replay custody: shutdown names each stop before entering it.
    this.#perform(phase).then(resolve, reject);
    return attempt;
  }
  async #perform(phase) {
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
