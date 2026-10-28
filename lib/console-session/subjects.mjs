// WHICH AGENT A KEY ACTS ON: the subject of the open menu, and where leaving the picker goes back to. Both are bound
// BY IDENTITY when they are chosen and resolved against the list as it is when they are used, because between those
// two moments the list refreshes every two seconds and every index below a change moves.
//
// THIS IS THE CODE THAT DECIDES WHICH AGENT A STOP HITS, and it has been wrong four times, each in a different
// costume of one defect: a subject re-derived from the cursor after the rows shifted. The comments below are the
// record of those four, kept with the lines they explain.

export class Subjects {
  //: WHICH PROCESS THE OPEN MENU IS ABOUT, captured when it opened. `confirming` records the OPERATION; this records
  //: the SUBJECT, and without it a refresh between the choice and the `y` silently retargets the action -- measured:
  //: confirming `stop` for bravo, pressing `y` after alpha exited, and stopping charlie.
  #actionTargetId = null;
  //: Where Ctrl+] goes back to. Set when the picker opens, cleared when it closes.
  #pickerReturnId = null;

  /** The agent the open menu is about, or null. */
  get actionTargetId() { return this.#actionTargetId; }

  /**
   * What `action` binds, read from the OLD focus -- `selectedId` is the agent under the cursor BEFORE the router's new
   * state replaces it -- and where leaving the picker goes back to: an id, or null when this key does not leave it.
   */
  capture(action, selectedId) {
    // ── LEAVING THE PICKER RE-POINTS BY IDENTITY, NOT BY INDEX.
    //
    // `selected` is an index into what is VISIBLE, and closing the picker drops the query -- so the whole list comes
    // back and index 0 stops meaning the agent that was highlighted. Accepting a search for "critic" landed the
    // operator on `sc-lead`, which is the same wrong answer as choosing nothing, delivered as though it had worked.
    // Caught by this file's own test.
    //
    // WHICH PROCESS depends on which way they left, and the two are genuinely different intents:
    //   accept (Enter)  -> the one under the cursor now. That is the choice they just made.
    //   close (Ctrl+])  -> the one they were on BEFORE the picker opened. That is what abandoning a search means;
    //                      anything else makes cancelling move the selection.
    //
    // Read from the OLD focus, before `state` replaces it: `selected` is derived from the focus, so a line later it
    // would already answer for the new list.
    if (action === "picker-open") this.#pickerReturnId = selectedId;
    // ── A MENU IS ABOUT ONE PROCESS, AND IT IS THE ONE THAT WAS SELECTED WHEN IT OPENED.
    //
    // Read from the OLD focus, before `state` replaces it, for the same reason the picker's return id is. Preserving
    // `confirming` across a refresh -- which the session does, so a prompt survives long enough to be answered -- made
    // the SUBJECT the thing that drifts: the operation was kept and the target was re-derived from `selected` at `y`
    // time, so a list that shifted underneath moved the stop onto a different agent. That is the row-shift defect for
    // the third time in one session, on the one path that ends somebody's work.
    if (action === "menu-open") this.#actionTargetId = selectedId;
    if (action === "menu-close" || action === "confirm-cancel") this.#actionTargetId = null;
    // A QUERY THAT MATCHES NOTHING FALLS BACK TO WHERE THE PICKER OPENED. `selected` is null when the filter matches
    // no row, so the identity re-point was skipped and `syncProcesses` clamped -1 up to 0 -- landing the operator on
    // the FIRST agent. That is the same wrong answer this re-pointing was written to remove, surviving in the branch
    // nobody drove: search for something that does not exist, press Enter, press Enter again, and you are attached to
    // a process you never chose.
    return action === "picker-accept" ? (selectedId ?? this.#pickerReturnId)
      : action === "picker-close" ? this.#pickerReturnId
        : null;
  }

  /**
   * Leaving the picker has re-pointed the selection; nothing is waiting to return.
   *
   * NO MUTANT CAN KILL THIS TODAY: the return id is read only on leaving the picker, and opening it again writes it
   * first, so a stale one is never read. It is cleared so the field never names a return nobody is waiting for.
   */
  returned() {
    this.#pickerReturnId = null;
  }

  /**
   * A MENU'S SUBJECT BELONGS TO THE MENU (v0.7.1 review, E1). An empty poll closes the menu, and a subject left bound
   * rode along on the next `chose:start`: "start of alpha failed" beside "starting bravo". Outside the menu and its
   * confirmation, nothing is bound.
   */
  releaseOutside(mode) {
    if (mode !== "menu" && mode !== "confirm") this.#actionTargetId = null;
  }

  /**
   * ── ATTACHING FROM THE MENU GOES TO THE AGENT THE MENU NAMED, NOT TO THE CURSOR.
   *
   * THE FOURTH WRONG-SUBJECT DEFECT IN THIS FEATURE, and it arrived with the fix for the third. Performing `attach`
   * inside the router made the menu's own default work -- it had been inert -- and the router is pure, so it moved the
   * keyboard by MODE and left the subject to the cursor. Every other menu action resolves by the identity captured
   * when the menu opened; this one did not, so the two disagreed exactly when the list shifted.
   *
   * MEASURED: menu opened on bravo in [alpha, bravo, charlie], alpha exits, the prompt still reads "actions for bravo",
   * Enter on `attach` -- and the keyboard lands on charlie. Review drove it through the real daemon adapter and watched
   * `runner.write` receive charlie's id.
   *
   * GONE MEANS REFUSED, exactly as it does for stop. The menu named an agent; if that agent is no longer there,
   * attaching to whichever row took its place is the same wrong-subject bug wearing a harmless-looking costume -- the
   * operator would be typing into somebody else's session believing it was the one they chose.
   *
   * @returns {number} the menu's agent's index in `processes`, or -1 when it is gone; the binding ends either way
   */
  takeAttachTarget(processes) {
    const at = this.#actionTargetId ? processes.findIndex((row) => row?.id === this.#actionTargetId) : -1;
    // NO MUTANT CAN KILL THIS ONE EITHER: `attach` always re-syncs at once, and the sync releases a subject outside the
    // menu. It is ended here as well, at the moment the menu is done with it, rather than left to the next sync.
    this.#actionTargetId = null;
    return at;
  }

  /**
   * The process a confirmed or chosen action names, or null. The binding ends with the action.
   *
   * RESOLVED BY IDENTITY AGAINST THE CURRENT LIST, never from the cursor. The cursor is where it is NOW; the menu is
   * about where it was when the menu opened, and between those two moments the list refreshes every two seconds.
   *
   * GONE MEANS REFUSED, not "do it to whatever is there instead". A process that exited while its own stop was being
   * confirmed does not need stopping, and the row that took its place did not consent to anything.
   *
   * @param {string|null} performed  the action's name, or null when this key performed nothing
   */
  takeActionTarget(performed, processes) {
    const target = performed && this.#actionTargetId
      ? (processes.find((row) => row?.id === this.#actionTargetId) ?? null)
      : null;
    if (performed) this.#actionTargetId = null;
    return target;
  }
}
