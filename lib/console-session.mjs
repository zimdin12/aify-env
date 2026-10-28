// Which process the operator is watching, and the follower that watches it.
//
// THE STATEFUL PIECE, and the only one. Everything else in the console is a function from values to
// values; this owns the two things that change over time -- where the selection is, and which stream
// is open -- so the render loop can stay a loop and `dashboard.mjs` does not grow a lifecycle.
//
// ITS PARTS (0.9.8b), each owning what it alone changes: the start list's rows (console-session/start-list.mjs), the
// pane's stream and the evidence that the operator can see it (console-session/pane-follower.mjs), and the cutting of
// reads into keys and pastes (console-session/input-decoder.mjs). What stays here is the focus, the process list, the
// selection's identity across refreshes, and what each key does.

import { MIN_COLUMNS_FOR_PANE } from "./console-view.mjs";
import { SHUTDOWN, initialFocus, reconcileFocus, routeKey } from "./keys.mjs";
import { PASTE_END, PASTE_START } from "./bracketed-paste.mjs";
import { InputDecoder } from "./console-session/input-decoder.mjs";
import { PaneFollower } from "./console-session/pane-follower.mjs";
import { StartList } from "./console-session/start-list.mjs";
import { matchesQuery } from "./start-list.mjs";

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
  #start;
  #pane;
  #input;

  constructor({
    endpoint = "", fetchImpl = undefined, makeFollower = null, actions = null,
    //: CALLED WHEN THE PANE HAS SOMETHING NEW TO SHOW, so the view can draw it.
    //:
    //: REQUIRED, NOT AN OPTIMISATION, and that is worth stating because it looks like one. Input is
    //: gated on a STREAMING frame having been drawn, and until this existed nothing drew one when a
    //: stream opened: the refresh timer was the only thing that ever redrew, so attaching left the
    //: console refusing keys against a "connecting..." frame for up to `intervalMs`.
    //:
    //: THE VIEW DECIDES THE CADENCE. This says something changed; how often that becomes a frame is
    //: the caller's business, because only the caller knows what a frame costs it.
    onProgress = null,
    //: NO CONSOLE AT ALL: `p` and Enter do nothing. Set where every worker already has a Herdr space.
    withoutConsole = false,
    //: WHETHER Ctrl+C ON THE DASHBOARD ASKS BEFORE IT IS REPORTED. The daemon's own view sets this:
    //: there Ctrl+C stops the environment and every worker it owns. A client leaves at no cost.
    confirmInterrupt = false,
    //: The clock a failed stream's retry is paced by, injected so a test can move it.
    now = () => Date.now(),
    //: How long a FAILED stream waits before it is opened again. A refresh is every two seconds, so
    //: this is at most one reconnect per refresh.
    retryMs = 2000,
  } = {}) {
    this.endpoint = endpoint;
    this.now = now;
    this.retryMs = retryMs;
    this.withoutConsole = withoutConsole === true;
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    //: WHAT THE CALLER CAN ACTUALLY PERFORM. Attach alone unless it says otherwise, because that
    //: is the one action needing no executor. Offering more than the caller can do would be a
    //: control that silently does nothing.
    this.focus = {
      ...initialFocus(0),
      menuActions: Array.isArray(actions) ? actions : null,
      confirmInterrupt: confirmInterrupt === true,
    };
    //: WHICH PROCESS THE OPEN MENU IS ABOUT, captured when it opened. `confirming` records the
    //: OPERATION; this records the SUBJECT, and without it a refresh between the choice and the
    //: `y` silently retargets the action -- measured: confirming `stop` for bravo, pressing `y`
    //: after alpha exited, and stopping charlie.
    this.actionTargetId = null;
    this.processes = [];
    //: Where Ctrl+] goes back to. Set when the picker opens, cleared when it closes.
    this.pickerReturnId = null;
    this.#start = new StartList();
    //: The session's `onProgress` is asked when progress arrives, not captured now, as it always was.
    this.#pane = new PaneFollower({ endpoint, fetchImpl, makeFollower, onProgress: () => this.onProgress?.(), now, retryMs });
    this.#input = new InputDecoder({
      key: (data) => this.handleInput(data), paste: (text) => this.#handlePaste(text), mode: () => this.focus?.mode,
    });
  }

  /** The open stream, or null (read by tests). */
  get follower() { return this.#pane.follower; }
  /** The process the open stream follows, or null. */
  get watchedId() { return this.#pane.watchedId; }
  /** Which opening of the start list is current; the caller compares it before filling the list (v0.7.1, W12). */
  get startOpening() { return this.#start.opening; }

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
    const query = this.focus?.query;
    return this.processes.filter((row) => matchesQuery([row?.label, row?.title, row?.id], query));
  }

  /** The start list's rows under its search, which is what its cursor and Enter index (v0.7.7). */
  startVisible() {
    return this.#start.visible(this.focus?.startQuery);
  }

  /** Point the router's count at what the search leaves, keeping the cursor on a row. */
  #countStartable() {
    const n = this.startVisible().length;
    const at = Number.isFinite(this.focus?.startAt) ? this.focus.startAt : 0;
    this.focus = { ...this.focus, startCount: n, startAt: n === 0 ? 0 : Math.min(Math.max(0, at), n - 1) };
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
    // THE AGENT UNDER THE CURSOR, read before the list changes (0.9.7). See the re-pointing below.
    const cursorId = this.selected?.id ?? null;
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
    } else if (cursorId) {
      // AND OFF A PANE, THE CURSOR STAYS ON ITS AGENT (0.9.7). The table can be sorted by what needs looking at
      // (`o`), which reorders it whenever a state changes; an index kept across that points at another agent, and
      // the next `m` would offer to stop it. Where the agent is gone, the index clamps below as before.
      const at = rows.findIndex((row) => row?.id === cursorId);
      if (at >= 0) this.focus = { ...this.focus, selected: at };
    }
    // Reconciled against the VISIBLE count for the same reason: with a filter on, the selection
    // indexes what is on screen, and reconciling against every process would let the cursor sit past
    // the end of a narrowed list.
    this.focus = reconcileFocus(this.focus, rows.length);
    // A MENU'S SUBJECT BELONGS TO THE MENU (v0.7.1 review, E1). An empty poll closes the menu here,
    // and a subject left bound rode along on the next `chose:start`: "start of alpha failed" beside
    // "starting bravo". Outside the menu and its confirmation, nothing is bound.
    if (this.focus.mode !== "menu" && this.focus.mode !== "confirm") this.actionTargetId = null;

    // NOTHING IS READ WHILE THE CONSOLE IS HIDDEN. `pane()` returning null gated the DRAWING and
    // left the RESOURCES running: measured 2026-09-08 after review reported it, a hidden pane still
    // opened a follower and set `watchedId`, and every arrow key opened and closed one -- three HTTP
    // connections for three keystrokes at a pane nobody could see. On a host with agents streaming
    // continuously that is a live connection and a growing ring buffer per hidden pane.
    //
    // The operator asked for the console "only when shown (only then)". This is the half of that
    // which is about cost rather than pixels.
    // AND NOT WHILE THE PANE CANNOT BE DRAWN AT ALL. `paneHidden` says the operator does not want it;
    // `canDrawPane` says the terminal cannot show it, and BOTH mean nobody is reading the stream.
    // Gating on the flag alone left a narrow terminal opening a connection and filling a buffer for a
    // pane the compositor refuses to draw -- measured at 79 columns, one under the minimum.
    const readable = !this.focus.paneHidden && this.canDrawPane();
    const target = readable ? (this.selected?.id ?? null) : null;
    // Opened, kept, retried or closed by the pane's own rules (console-session/pane-follower.mjs).
    this.#pane.follow(target);
    return this;
  }

  /**
   * Take a fresh answer to "which agents could this host start".
   *
   * THE COUNT GOES INTO THE FOCUS because the router wraps the cursor on it, and the router is pure
   * -- it cannot see a list. A count left behind would leave Enter reporting nothing on a list the
   * operator can see, which reads as the key not working.
   *
   * THE CURSOR IS CLAMPED, NOT RESET, for the reason the process list's is: agents come and go while
   * the list is open, and jumping back to the top under the operator's hand is worse than staying
   * near where they were looking.
   */
  noteStartable(rows, problem = "", service = "", skipped = []) {
    this.#start.note(rows, problem, service, skipped);
    this.#countStartable();
    return this;
  }

  /** What the renderer draws for the start list: the rows, the cursor, and any reason it is empty. */
  startView() {
    return this.#start.view({
      query: String(this.focus?.startQuery ?? ""),
      at: Number.isFinite(this.focus?.startAt) ? this.focus.startAt : 0,
    });
  }

  /**
   * Interpret one READ, which may carry several keys and pastes; how it is cut is the decoder's
   * (console-session/input-decoder.mjs), and what each piece does is `handleInput` and `#handlePaste`.
   *
   * @returns {Array<ReturnType<ConsoleSession["handleInput"]>>} one result per key handled
   */
  handleChunk(data) {
    return this.#input.chunk(data);
  }

  /** Give up input held back for the rest of a paste marker, once the terminal has gone quiet. */
  flushInput() {
    return this.#input.flush();
  }

  /** Milliseconds until `flushInput` is due, or null when nothing is held. */
  get inputFlushMs() {
    return this.#input.waitMs;
  }

  /**
   * One paste. Never a key: in an attached pane it goes to the agent whole, WITH the markers when the
   * agent turned bracketed paste on for itself (the checkpoint carries that mode) and without them
   * when it did not, as a terminal would; in find it is text for the filter; anywhere else it does
   * nothing, which is the only answer for a list, a menu or a question.
   */
  #handlePaste(text) {
    const nothing = { quit: false, interrupt: false, toPty: null, action: null, perform: null, startAgent: null };
    if (this.focus.mode === "pty") {
      if (!this.inputIsLive() || !text) return nothing;
      const markers = this.#pane.follower?.screen?.bracketedPaste === true;
      return { ...nothing, toPty: markers ? `${PASTE_START}${text}${PASTE_END}` : text };
    }
    if (this.focus.mode === "picker") {
      const typed = [...text].filter((ch) => ch >= " " && ch !== String.fromCharCode(127)).join("");
      if (!typed) return nothing;
      this.focus = { ...this.focus, query: `${this.focus.query ?? ""}${typed}` };
      this.syncProcesses(this.processes);
      return { ...nothing, action: "query" };
    }
    if (this.focus.mode === "start") {
      const typed = [...text].filter((ch) => ch >= " " && ch !== String.fromCharCode(127)).join("");
      if (!typed) return nothing;
      this.focus = { ...this.focus, startQuery: `${this.focus.startQuery ?? ""}${typed}`, startAt: 0 };
      this.#countStartable();
      return { ...nothing, action: "start-query" };
    }
    return nothing;
  }

  /**
   * Interpret one key, or one chunk in a mode that takes a chunk whole.
   *
   * @returns {{quit: boolean, interrupt: boolean, toPty: string|null, action: string|null,
   *   perform: object|null, startAgent: object|null}}
   */
  handleInput(data) {
    //: WHETHER THIS KEYSTROKE CAME OUT OF THE ACTIONS MENU. The router reports `attach` for both the
    //: dashboard's Enter and the menu's, and they resolve their subject differently -- see below.
    const fromMenu = this.focus?.mode === "menu";
    // READ BEFORE THE ROUTER'S NEW STATE REPLACES IT. Choosing closes the list and resets the cursor
    // to 0, so reading `this.focus.startAt` a line later would name the FIRST agent every time --
    // the same shape as the picker's return id, which is read here for the same reason.
    // AND FROM THE FILTERED LIST, which is the one the operator is looking at and the cursor indexes.
    const chosenStart = this.focus?.mode === "start"
      ? (this.startVisible()[Number.isFinite(this.focus.startAt) ? this.focus.startAt : 0] ?? null)
      : null;
    const { state, toPty, action } = routeKey(data, this.focus);
    if (this.withoutConsole && (action === "pane-toggle" || action === "attach")) {
      return { quit: false, interrupt: false, toPty: null, action: null, perform: null, startAgent: null };
    }

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
    // OPENING THE LIST MARKS IT UNANSWERED AGAIN, and drops the old rows (console-session/start-list.mjs).
    if (action === "start-open") this.#start.open();
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
    // THE COUNT THE ROUTER READS FOR Enter, emptied with the rows so nothing can be chosen yet.
    if (action === "start-open") this.focus = { ...this.focus, startCount: 0 };
    if (action === "start-query") this.#countStartable();

    if (returnTo !== null && (action === "picker-accept" || action === "picker-close")) {
      // Against the UNFILTERED list, because the query has just been cleared. A process that exited
      // while the picker was open is simply not found, and the clamped selection stands -- which is
      // the same answer every other vanishing process gets here.
      const at = this.processes.findIndex((row) => row?.id === returnTo);
      if (at >= 0) this.focus = { ...this.focus, selected: at };
      this.pickerReturnId = null;
    }
    // ── ATTACHING FROM THE MENU GOES TO THE AGENT THE MENU NAMED, NOT TO THE CURSOR.
    //
    // THE FOURTH WRONG-SUBJECT DEFECT IN THIS FEATURE, and it arrived with the fix for the third.
    // Performing `attach` inside the router made the menu's own default work -- it had been inert --
    // and the router is pure, so it moved the keyboard by MODE and left the subject to the cursor.
    // Every other menu action resolves by the identity captured when the menu opened; this one did
    // not, so the two disagreed exactly when the list shifted.
    //
    // MEASURED: menu opened on bravo in [alpha, bravo, charlie], alpha exits, the prompt still reads
    // "actions for bravo", Enter on `attach` -- and the keyboard lands on charlie. Review drove it
    // through the real daemon adapter and watched `runner.write` receive charlie's id.
    //
    // GONE MEANS REFUSED, exactly as it does for stop. The menu named an agent; if that agent is no
    // longer there, attaching to whichever row took its place is the same wrong-subject bug wearing
    // a harmless-looking costume -- the operator would be typing into somebody else's session
    // believing it was the one they chose.
    if (action === "attach" && fromMenu) {
      const at = this.actionTargetId
        ? this.processes.findIndex((row) => row?.id === this.actionTargetId)
        : -1;
      this.actionTargetId = null;
      if (at < 0) {
        this.focus = { ...this.focus, mode: "dashboard" };
        return { quit: false, interrupt: false, toPty: null, action: "attach-refused", perform: null, startAgent: null,
          refusal: "attach refused: that process has gone" };
      }
      this.focus = { ...this.focus, selected: at };
      // AND THE OLD BINDING IS OVER, which is the half that was missing. `attach` is in
      // RESELECTING_ACTIONS, so `syncProcesses` runs immediately below -- and its rule for a pane
      // in `pty` mode is to keep the keyboard on the process it is ALREADY bound to when rows
      // shift, which re-pointed the selection away from the agent this menu just named. Review
      // measured it: menu on bravo, alpha exits, the pane was following charlie by then, and
      // Attach landed the keyboard on charlie with `x` delivered there.
      //
      // That rule protects an EXISTING binding against a list that moved underneath it. An
      // explicit Attach is not a list moving; it is a new binding, resolved by identity three
      // lines up. Closing the old follower says so, and `#ensureFollower` opens one on the agent
      // the operator chose. It also puts `paneRendered` back to false, so no keystroke reaches
      // the new agent before a frame of it has been drawn -- the guarantee attaching from the
      // dashboard already makes.
      this.#pane.close();
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
        return { quit: false, interrupt: false, toPty: null, action: "attach-refused",
          refusal: `attach needs a terminal at least ${MIN_COLUMNS_FOR_PANE} columns wide` };
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
    // STARTING TRAVELS ON ITS OWN FIELD, never as a `perform`. That one carries a PROCESS, and the
    // whole point of this list is agents that have none -- so folding them together would need a
    // fake process object, and every executor downstream would have to tell the two apart by
    // inspecting it. The word is different because the thing is different.
    const startAgent = action === "chose:start" ? chosenStart : null;
    const spaceAgent = action === "start-toggle-space" ? chosenStart : null;
    return {
      quit: action === "quit",
      // A CONFIRMED SHUTDOWN IS THE INTERRUPT, reported only once `y` has answered the question.
      interrupt: action === "interrupt" || action === `confirmed:${SHUTDOWN}`,
      toPty,
      action,
      perform,
      startAgent,
      spaceAgent,
    };
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
    this.#pane.noteColumns(columns);
    if (this.focus.mode === "pty" && !this.canDrawPane()) {
      this.focus = { ...this.focus, mode: "dashboard" };
    }
    // AND RE-DERIVE THE STREAM, because drawability now gates resources as well as input: widening a
    // window has to OPEN the follower it was refusing, and narrowing has to close it. Without this the
    // gate would be one-way -- an operator who resized to fix a too-narrow pane would get a pane that
    // stayed empty for ever.
    this.syncProcesses(this.processes);
    return this;
  }

  /** Whether a pane can actually be put on this terminal; an unreported width cannot (console-session/pane-follower.mjs). */
  canDrawPane() {
    return this.#pane.canDraw();
  }

  /**
   * A pane frame actually reached the screen, or did not: told by the thing that drew it, because nothing else can
   * know (console-session/pane-follower.mjs).
   */
  notePaneRendered(rendered) {
    // REVOKED THE MOMENT IT STOPS BEING TRUE, for the same reason narrowing revokes: the operator
    // did not detach, the screen simply stopped carrying their agent, and input has to stop with it.
    if (!this.#pane.noteRendered(rendered) && this.focus.mode === "pty") {
      this.focus = { ...this.focus, mode: "dashboard" };
    }
    return this;
  }

  /** Whether a keystroke may reach the process right now: wide enough, a live frame of it drawn, a live stream. */
  inputIsLive() {
    return this.#pane.inputIsLive();
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
    if (this.focus?.paneHidden) return null;
    return this.#pane.pane(this.selected, { attached: this.focus.mode === "pty" });
  }

  /** Close the stream. Safe to call twice. */
  stop() {
    this.#pane.close();
    return this;
  }
}
