// Which process the operator is watching, and the follower that watches it.
//
// THE STATEFUL PIECE, and the only one. Everything else in the console is a function from values to
// values; this owns the two things that change over time -- where the selection is, and which stream
// is open -- so the render loop can stay a loop and `dashboard.mjs` does not grow a lifecycle.
//
// A FOLLOWER IS A CONNECTION, so swapping one is not free and must not happen by accident. The
// selection moving is the only thing that opens or closes a stream here; a refresh that returns the
// same process list must not churn it, or an operator scrolling a busy host would open and abandon a
// connection per keypress.

import { initialFocus, reconcileFocus, routeKey } from "./keys.mjs";
import { OutputFollower } from "./output-follower.mjs";

/**
 * The console's state across refreshes.
 *
 * `makeFollower` is injected so the whole lifecycle is testable without a daemon: the default builds
 * a real `OutputFollower`, and a test hands in something that records what it was asked for.
 */
export class ConsoleSession {
  constructor({ endpoint = "", fetchImpl = undefined, makeFollower = null } = {}) {
    this.endpoint = endpoint;
    this.focus = initialFocus(0);
    this.processes = [];
    this.follower = null;
    this.watchedId = null;
    this.makeFollower = makeFollower || ((id) => new OutputFollower({
      endpoint: this.endpoint,
      id,
      ...(fetchImpl ? { fetchImpl } : {}),
    }));
  }

  /** The process the selection currently points at, or null. */
  get selected() {
    const at = this.focus.selected;
    return at >= 0 && at < this.processes.length ? this.processes[at] : null;
  }

  /**
   * Take a fresh process list from the snapshot and reconcile everything to it.
   *
   * PROCESSES COME AND GO WHILE THE PANE IS OPEN -- that is the normal case, not an edge one, since
   * watching work start and finish is the point of the view. The selection clamps rather than
   * resetting, and the follower only changes when the process under the selection actually changes.
   */
  syncProcesses(processes) {
    this.processes = Array.isArray(processes) ? processes : [];
    this.focus = reconcileFocus(this.focus, this.processes.length);

    const target = this.selected?.id ?? null;
    if (target === this.watchedId) return this;

    // THE OLD STREAM IS CLOSED BEFORE THE NEW ONE OPENS. Leaving it running would keep a connection
    // and a growing buffer alive for a process nobody is looking at, once per selection move.
    this.#closeFollower();
    if (target) {
      this.watchedId = target;
      this.follower = this.makeFollower(target);
      // Deliberately not awaited: the render loop must not block on a connection, and the follower
      // reports its own state through `status` rather than through a rejection.
      Promise.resolve(this.follower.start?.()).catch(() => {});
    }
    return this;
  }

  /**
   * Interpret one chunk of input.
   *
   * @returns {{quit: boolean, toPty: string|null, action: string|null}}
   */
  handleInput(data) {
    const { state, toPty, action } = routeKey(data, this.focus);
    this.focus = state;
    if (action === "move") {
      // A move can change which process is under the selection, so the follower is re-derived from
      // the same list rather than from an assumption about which way the cursor went.
      this.syncProcesses(this.processes);
    }
    return { quit: action === "quit", toPty, action };
  }

  /** What `composeConsole` needs, or null when nothing is selected. */
  pane() {
    const process_ = this.selected;
    if (!process_ || !this.follower) return null;
    return {
      id: process_.id,
      label: process_.label,
      status: this.follower.status,
      exit: this.follower.exit,
      attached: this.focus.mode === "pty",
      lines: (opts) => this.follower.lines(opts),
    };
  }

  #closeFollower() {
    try {
      this.follower?.stop?.();
    } catch {
      // A follower that throws on stop has already stopped mattering.
    }
    this.follower = null;
    this.watchedId = null;
  }

  /** Close the stream. Safe to call twice. */
  stop() {
    this.#closeFollower();
    return this;
  }
}
