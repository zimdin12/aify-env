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

import { MIN_COLUMNS_FOR_PANE } from "./console-view.mjs";
import { STREAMING } from "./output-follower.mjs";
import { initialFocus, reconcileFocus, routeKey } from "./keys.mjs";
import { OutputFollower } from "./output-follower.mjs";

//: Actions after which the row under the selection may be a different process. DERIVED FROM WHAT
//: EACH ACTION DOES, not a list of every action: a move slides the cursor, and everything to do with
//: the picker changes the LIST the cursor indexes. Missing one shows the operator one agent's name
//: over another agent's output, which is the worst possible way for this to be wrong.
//: Actions after which the follower has to be re-derived from the list. `pane-toggle` is here
//: because SHOWING the console is what opens a stream and HIDING it is what closes one -- the
//: selection has not moved, but which process is being read has changed from "none" to "this
//: one" or back.
const RESELECTING_ACTIONS = new Set(
  ["move", "query", "picker-open", "picker-accept", "picker-close", "pane-toggle", "attach"]);
//: `attach` is in that set because attaching REVEALS a hidden pane (typing into one nobody can
//: see is not a feature), and revealing it is what opens the stream.

/**
 * The console's state across refreshes.
 *
 * `makeFollower` is injected so the whole lifecycle is testable without a daemon: the default builds
 * a real `OutputFollower`, and a test hands in something that records what it was asked for.
 */
export class ConsoleSession {
  constructor({ endpoint = "", fetchImpl = undefined, makeFollower = null, actions = null } = {}) {
    this.endpoint = endpoint;
    //: WHAT THE CALLER CAN ACTUALLY PERFORM. Attach alone unless it says otherwise, because that
    //: is the one action needing no executor. Offering more than the caller can do would be a
    //: control that silently does nothing.
    this.focus = { ...initialFocus(0), menuActions: Array.isArray(actions) ? actions : null };
    //: Unknown until a caller says so, and unknown means NOT drawable. See `canDrawPane`.
    this.columns = null;
    //: Whether the LAST draw actually put a pane on the screen. False until something says so --
    //: readiness is an observation, and an unobserved pane is not a readable one.
    this.paneRendered = false;
    //: WHICH PROCESS THE OPEN MENU IS ABOUT, captured when it opened. `confirming` records the
    //: OPERATION; this records the SUBJECT, and without it a refresh between the choice and the
    //: `y` silently retargets the action -- measured: confirming `stop` for bravo, pressing `y`
    //: after alpha exited, and stopping charlie.
    this.actionTargetId = null;
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
    const previous = Array.isArray(processes) ? processes : [];
    // ── AN ATTACHED PANE IS BOUND TO A PROCESS, NOT TO A ROW NUMBER.
    //
    // `reconcileFocus` preserves `pty` mode and CLAMPS the index, which is right for the dashboard
    // and dangerous while attached: the operator is typing at `alpha`, `alpha` exits, index 0 now
    // means `bravo`, and the very next keystroke -- including a pasted instruction -- is written
    // into a DIFFERENT agent's live PTY. Nothing on screen announces the swap.
    //
    // Measured on the real class: attach to alpha, remove alpha, and the session reported `pty` mode
    // with `bravo` selected. That was reachable before this view had a keyboard only through the
    // `tui` client; the daemon now routes keys straight to `runner.write`, which is what turns it
    // from a display bug into typing at the wrong agent.
    //
    // DETACHING IS THE FAIL-CLOSED ANSWER. Re-pointing by identity is impossible -- the process the
    // keyboard was bound to is gone -- so the keyboard goes back to the dashboard, where a keystroke
    // moves a cursor rather than reaching a process. The operator presses Enter again if they want
    // the lane that took its place.
    this.processes = previous;
    // RE-POINTED BY IDENTITY, then reconciled. The guard here USED TO ask only whether the watched
    // process was still in the list, which is half the rule the comment above states and left the
    // dangerous half open: attach to `bravo` in [alpha, bravo, charlie] and remove ALPHA, and
    // `bravo` is still running so the mode survives -- while `selected` is an INDEX and every row
    // below the removal has shifted up. Index 1 now means `charlie`, the follower moves to
    // `charlie`, and the next keystroke enters `charlie`'s live PTY while the operator is looking at
    // a pane they opened on `bravo`. Nothing on screen announces it. A REORDER does the same with no
    // removal at all. Found by review 2026-09-08; testing only the removal of the ATTACHED process
    // misses the whole class.
    //
    // AGAINST THE VISIBLE LIST, not the whole one, and that is the same question twice: a process
    // filtered out of view is one the operator cannot see the pane for, and `title` DOES change
    // while an agent works, so a filter can hide the watched row without anything exiting.
    const rows = this.visible();
    if (this.focus.mode === "pty" && this.watchedId) {
      const at = rows.findIndex((row) => row?.id === this.watchedId);
      // DETACHING IS THE FAIL-CLOSED ANSWER when the identity is gone. Re-pointing is impossible --
      // the process the keyboard was bound to is not there -- so the keyboard goes back to the
      // dashboard, where a keystroke moves a cursor rather than reaching a process. The operator
      // presses Enter again for whatever took its place.
      if (at < 0) this.focus = { ...this.focus, mode: "dashboard" };
      else this.focus = { ...this.focus, selected: at };
    }
    // Reconciled against the VISIBLE count for the same reason: with a filter on, the selection
    // indexes what is on screen, and reconciling against every process would let the cursor sit past
    // the end of a narrowed list.
    this.focus = reconcileFocus(this.focus, rows.length);

    // NOTHING IS READ WHILE THE CONSOLE IS HIDDEN. `pane()` returning null gated the DRAWING and
    // left the RESOURCES running: measured 2026-09-08 after review reported it, a hidden pane still
    // opened a follower and set `watchedId`, and every arrow key opened and closed one -- three HTTP
    // connections for three keystrokes at a pane nobody could see. On a host with agents streaming
    // continuously that is a live connection and a growing ring buffer per hidden pane.
    //
    // The operator asked for the console "only when shown (only then)". This is the half of that
    // which is about cost rather than pixels.
    const target = this.focus.paneHidden ? null : (this.selected?.id ?? null);
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
    // ── A MENU IS ABOUT ONE PROCESS, AND IT IS THE ONE THAT WAS SELECTED WHEN IT OPENED.
    //
    // Read from the OLD focus, before `state` replaces it, for the same reason the picker's return id
    // is. Preserving `confirming` across a refresh -- which this file now does, so a prompt survives
    // long enough to be answered -- made the SUBJECT the thing that drifts: the operation was kept
    // and the target was re-derived from `selected` at `y` time, so a list that shifted underneath
    // moved the stop onto a different agent. That is the row-shift defect for the third time in this
    // session, on the one path that ends somebody's work.
    if (action === "menu-open") this.actionTargetId = this.selected?.id ?? null;
    if (action === "menu-close" || action === "confirm-cancel") this.actionTargetId = null;
    // A QUERY THAT MATCHES NOTHING FALLS BACK TO WHERE THE PICKER OPENED. `this.selected` is null
    // when the filter matches no row, so the identity re-point was skipped and `syncProcesses`
    // clamped -1 up to 0 -- landing the operator on the FIRST agent. That is the same wrong answer
    // this re-pointing was written to remove, surviving in the branch nobody drove: search for
    // something that does not exist, press Enter, press Enter again, and you are attached to a
    // process you never chose.
    const returnTo = action === "picker-accept" ? (this.selected?.id ?? this.pickerReturnId)
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
    // NOTHING REACHES A PROCESS THE OPERATOR CANNOT SEE.
    //
    // Checked AFTER the routing rather than inside `keys.mjs`, because that file is pure and knows
    // nothing about terminals -- which is what makes every routing rule testable by calling a
    // function. Drawability is a property of a screen, so it is enforced by the object that has one.
    // ATTACH IS GATED ON WIDTH, FORWARDING ON READINESS, and they are deliberately different
    // questions. Refusing to attach until a frame has rendered would make Enter do nothing on the
    // first press -- the pane is revealed BY attaching, so no frame can exist yet. Refusing to
    // FORWARD until one has is the guarantee that matters: the mode may be entered optimistically,
    // and no byte leaves until the operator can see where it is going.
    if (toPty !== null && !this.inputIsLive()) {
      return { quit: false, interrupt: action === "interrupt", toPty: null, action, perform: null };
    }
    if (!this.canDrawPane()) {
      if (action === "attach") {
        // REFUSED, and NAMED, so the caller can say why. Entering `pty` here would be a mode whose
        // keys vanish: the compositor draws no pane, so there is nothing to type at and nothing to
        // read back.
        this.focus = { ...this.focus, mode: "dashboard" };
        return { quit: false, interrupt: false, toPty: null, action: "attach-refused" };
      }
      // NO SECOND GUARD ON FORWARDING, and that is a deletion rather than an omission. One was
      // written here and NO MUTANT COULD KILL IT: reaching it needs `pty` mode with an undrawable
      // pane, and there is no way to be in that state -- attaching requires a drawable pane, and the
      // only thing that changes the width is `noteViewport`, which revokes on the way past. Untested
      // code that cannot be reached is a liability, not defence in depth, so `noteViewport`'s
      // revocation above is the single enforcement point. Anything that lets the mode outlive
      // drawability must add its own revocation there rather than a filter here.
    }
    // A CONFIRMED ACTION, WITH THE PROCESS IT NAMES, and never one without the other. The caller
    // performs it -- the daemon can call its own runner, a `tui` client has to ask over HTTP -- which
    // is the same split `quit` and `interrupt` already use, and for the same reason: what these words
    // MEAN differs between the two callers, so this file only says which was chosen.
    //
    // ONLY `confirmed:` REACHES HERE FOR A DESTRUCTIVE ACTION. `keys.mjs` turns a destructive choice
    // into a question and does not report it until a `y` has been pressed, so there is no path where
    // a caller is handed `stop` because somebody pressed Enter.
    //
    // THE PROCESS IS RESOLVED NOW, from the selection the menu was opened on. Reading it later would
    // let the list move underneath -- the row-shift defect, on the one path that ends work.
    const performed = String(action || "").startsWith("confirmed:") ? action.slice(10)
      : String(action || "").startsWith("chose:") ? action.slice(6)
        : null;
    // RESOLVED BY IDENTITY AGAINST THE CURRENT LIST, never from the cursor. `this.selected` is where
    // the cursor is NOW; the menu is about where it was when the menu opened, and between those two
    // moments the list refreshes every two seconds.
    //
    // GONE MEANS REFUSED, not "do it to whatever is there instead". A process that exited while its
    // own stop was being confirmed does not need stopping, and the row that took its place did not
    // consent to anything.
    const target = performed && this.actionTargetId
      ? (this.processes.find((row) => row?.id === this.actionTargetId) ?? null)
      : null;
    const perform = target ? { action: performed, process: target } : null;
    if (performed) this.actionTargetId = null;
    return { quit: action === "quit", interrupt: action === "interrupt", toPty, action, perform };
  }

  /**
   * How wide the terminal is, so this session can tell whether its pane is actually DRAWN.
   *
   * REVIEW REPRODUCED THE DEFECT THIS CLOSES: at 79 columns `composeConsole` returns the dashboard
   * alone -- no pane, by design, because two unreadable columns are worse than one readable one --
   * while `routeKey` went on forwarding every keystroke into the process. The operator types into an
   * agent with no screen on them, which is the P1 above wearing different clothes.
   *
   * SO `paneHidden` CANNOT BE THE ONLY GATE. It says what this session INTENDS; the compositor
   * decides what is actually drawn, and only the caller that owns the terminal knows the width.
   *
   * DETACHES IMMEDIATELY when the answer changes to no. The ordinary way to reach that is an operator
   * narrowing a window while attached: nothing about the session changed, the pane simply stopped
   * being drawn, and input has to stop with it.
   */
  noteViewport({ columns } = {}) {
    const width = Number(columns);
    this.columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : null;
    if (this.focus.mode === "pty" && !this.canDrawPane()) {
      this.focus = { ...this.focus, mode: "dashboard" };
    }
    return this;
  }

  /**
   * Whether a pane can actually be put on this terminal.
   *
   * FAILS CLOSED ON AN UNREPORTED WIDTH. A caller that never said how wide it is cannot be shown to
   * be drawable, and the cost of guessing wrong is blind typing into a live agent. Refusing is the
   * recoverable direction: a caller that forgets to report loses attach VISIBLY, where a permissive
   * default would hand it invisible input. A guard that passes when its input is missing is
   * decoration.
   */
  canDrawPane() {
    return this.columns !== null && this.columns >= MIN_COLUMNS_FOR_PANE;
  }

  /**
   * A pane frame actually reached the screen, or did not.
   *
   * TOLD BY THE THING THAT DREW IT, because nothing else can know. `canDrawPane` proves the layout
   * would PERMIT a pane; it cannot prove one was rendered, and review reproduced the difference:
   * input forwarded while the follower was still connecting, while it had failed with a 503 or a
   * 404, after the process had exited, and into a one-row screen carrying only a header. In every
   * one of those the operator is typing at something they cannot read.
   *
   * READINESS IS AN OBSERVATION, NOT A PREDICTION. That is the whole correction: the old gate asked
   * whether a pane COULD be drawn, and the question that matters is whether one WAS.
   */
  notePaneRendered(rendered) {
    this.paneRendered = rendered === true;
    // REVOKED THE MOMENT IT STOPS BEING TRUE, for the same reason narrowing revokes: the operator
    // did not detach, the screen simply stopped carrying their agent, and input has to stop with it.
    if (!this.paneRendered && this.focus.mode === "pty") {
      this.focus = { ...this.focus, mode: "dashboard" };
    }
    return this;
  }

  /**
   * Whether a keystroke may reach the process right now.
   *
   * THREE THINGS, AND ALL OF THEM ARE ABOUT WHAT THE OPERATOR CAN SEE: the terminal is wide enough,
   * a pane frame actually rendered, and the stream is LIVE. A pane showing "connecting", an exit
   * notice or a failure is a rendered frame and still not a place to type -- the keys would go
   * nowhere and the screen would not move, which is indistinguishable from the view being frozen.
   */
  inputIsLive() {
    return this.canDrawPane()
      && this.paneRendered === true
      && this.follower?.status === STREAMING;
  }

  /**
   * What `composeConsole` needs, or null when nothing is selected OR the pane is hidden.
   *
   * ONE ANSWER, and this is the place it is given. `dashboard.mjs` already derives the dashboard's
   * width from `Boolean(console_?.pane())` and passes the same call's result as the pane, so hiding
   * here widens the left column and drops the right one together. A second flag read at the compose
   * site would be a way for those two to disagree, which is a half-width dashboard beside nothing.
   */
  pane() {
    const process_ = this.selected;
    if (!process_ || !this.follower) return null;
    if (this.focus?.paneHidden) return null;
    return {
      id: process_.id,
      label: process_.label,
      status: this.follower.status,
      exit: this.follower.exit,
      attached: this.focus.mode === "pty",
      //: The width the process actually paints at, so the title can say when the pane is showing
      //: only part of it. 0 when the producer never said -- an older daemon, or a piped process --
      //: and 0 means "do not claim anything", not "80".
      screenCols: this.follower.meta?.cols ?? 0,
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
