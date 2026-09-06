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

//: Actions after which the row under the selection may be a different process. DERIVED FROM WHAT
//: EACH ACTION DOES, not a list of every action: a move slides the cursor, and everything to do with
//: the picker changes the LIST the cursor indexes. Missing one shows the operator one agent's name
//: over another agent's output, which is the worst possible way for this to be wrong.
const RESELECTING_ACTIONS = new Set(["move", "query", "picker-open", "picker-accept", "picker-close"]);

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
    //: Where Ctrl+] goes back to. Set when the picker opens, cleared when it closes.
    this.pickerReturnId = null;
    this.makeFollower = makeFollower || ((id) => new OutputFollower({
      endpoint: this.endpoint,
      id,
      ...(fetchImpl ? { fetchImpl } : {}),
    }));
  }

  /**
   * The rows the operator can currently see and move through.
   *
   * THE PICKER IS A FILTER OVER THIS LIST, NOT A SECOND LIST, and that is what keeps `keys.mjs` free
   * of any idea of what a process is. Selection there is an index into whatever is being shown, so
   * narrowing the list is the same event as a process exiting: the count changes and the focus
   * reconciles. Nothing in the key layer had to learn about names.
   *
   * MATCHED ON WHAT THE OPERATOR CAN SEE. The label is the agent id they think in, the title is what
   * the process set for itself, and the id is what the protocol uses -- all three are on screen, so
   * all three are searchable. Matching a field the list does not show would make a row appear for no
   * visible reason.
   */
  visible() {
    const query = String(this.focus?.query || "").trim().toLowerCase();
    if (!query) return this.processes;
    return this.processes.filter((row) => {
      const haystack = `${row?.label ?? ""} ${row?.title ?? ""} ${row?.id ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  /** The process the selection currently points at, or null. */
  get selected() {
    const rows = this.visible();
    const at = this.focus.selected;
    return at >= 0 && at < rows.length ? rows[at] : null;
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
    // AGAINST THE VISIBLE COUNT, not the whole list. With a filter on, the selection indexes what is
    // on screen; reconciling against every process would let the cursor sit past the end of a
    // narrowed list and point the pane at something the operator cannot see.
    this.focus = reconcileFocus(this.focus, this.visible().length);

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
   * @returns {{quit: boolean, interrupt: boolean, toPty: string|null, action: string|null}}
   */
  handleInput(data) {
    const { state, toPty, action } = routeKey(data, this.focus);

    // ── LEAVING THE PICKER RE-POINTS BY IDENTITY, NOT BY INDEX.
    //
    // `selected` is an index into what is VISIBLE, and closing the picker drops the query -- so the
    // whole list comes back and index 0 stops meaning the agent that was highlighted. Accepting a
    // search for "critic" landed the operator on `sc-lead`, which is the same wrong answer as
    // choosing nothing, delivered as though it had worked. Caught by this file's own test.
    //
    // WHICH PROCESS depends on which way they left, and the two are genuinely different intents:
    //   accept (Enter)  -> the one under the cursor now. That is the choice they just made.
    //   close (Ctrl+])  -> the one they were on BEFORE the picker opened. That is what abandoning a
    //                      search means; anything else makes cancelling move the selection.
    //
    // Read from the OLD focus, before `state` replaces it: `this.selected` is derived from
    // `this.focus`, so a line later it would already answer for the new list.
    if (action === "picker-open") this.pickerReturnId = this.selected?.id ?? null;
    const returnTo = action === "picker-accept" ? (this.selected?.id ?? null)
      : action === "picker-close" ? this.pickerReturnId
        : null;

    this.focus = state;

    if (returnTo !== null && (action === "picker-accept" || action === "picker-close")) {
      // Against the UNFILTERED list, because the query has just been cleared. A process that exited
      // while the picker was open is simply not found, and the clamped selection stands -- which is
      // the same answer every other vanishing process gets here.
      const at = this.processes.findIndex((row) => row?.id === returnTo);
      if (at >= 0) this.focus = { ...this.focus, selected: at };
      this.pickerReturnId = null;
    }
    // ANY ACTION THAT CHANGES WHAT IS ON SCREEN re-derives the follower from the list, rather than
    // from an assumption about which way the cursor went. Typing in the picker is one of these: a
    // keystroke narrows the list, which moves what is under the selection without the selection
    // itself having moved -- and the pane would otherwise keep streaming a process that is no
    // longer shown.
    if (RESELECTING_ACTIONS.has(action)) {
      this.syncProcesses(this.processes);
    }
    // QUIT AND INTERRUPT ARE HANDED BACK SEPARATELY. The daemon renders this view in the terminal it
    // was started from, where Ctrl+C means "stop the environment"; `aify-env tui` is a client where
    // both mean leave. Deciding here would force one answer on both.
    return { quit: action === "quit", interrupt: action === "interrupt", toPty, action };
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
