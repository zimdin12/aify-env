// What one handled key asks of the view's caller and its screen: the layout switches (`v`, `o`, a pane's letter), the
// start list's fetch and starts, a confirmed action, a herdr space, quitting, interrupting, and keys meant for a
// process. It owns the three things those change: the layout, the last outcome, and the start awaiting its worker.
//
// In: the session's result for one key. Out: `{leave, forgetFrame}`, which the view applies; everything that answers
// later (a start, an action, a list) reports through `report`, which draws at once.

import { toggleCollapsed, writeLayoutChange } from "../tui-layout.mjs";
import { ROW_SORTS } from "../tui-panes/row-order.mjs";
import { actionOutcomeNotice, startOutcomeNotice } from "../action-outcome.mjs";

export class KeyActions {
  #session;
  #notices;
  #repaint;
  #isStopped;
  #writeLayout;
  #callbacks;
  //: WHICH PANES, IN WHAT ORDER, as the view started with them and as `v`, `o` and the pane menu changed them.
  #layout;
  #noRoom;
  //: THE LAST OUTCOME, drawn above the hint where fitting never reaches it (v0.7.7). NOTICES keeps the history and is
  //: the first thing trimmed.
  #outcome = "";
  //: The agent a start was accepted for: "starting X…" stays until its worker is in the process list.
  #pendingStart = null;

  /**
   * @param {{session: object, layout: object, notices: object|null, repaint: () => void, isStopped: () => boolean,
   *   writeLayout?: Function, onQuit?: Function|null, onInterrupt?: Function|null, onAction?: Function|null,
   *   onStartList?: Function|null, onStartAgent?: Function|null, onSetHerdrSpace?: Function|null,
   *   onInput?: Function|null, noRoom?: () => Set<string>}} deps  the callbacks are the caller's, as `startDashboard`
   *   documents them; `noRoom` is the panes the last frame drew ▹
   */
  constructor({ session, layout, notices, repaint, isStopped, writeLayout = writeLayoutChange, noRoom = () => new Set(),
    ...callbacks }) {
    this.#noRoom = noRoom;
    this.#session = session;
    this.#layout = layout;
    this.#notices = notices;
    this.#repaint = repaint;
    this.#isStopped = isStopped;
    this.#writeLayout = writeLayout;
    this.#callbacks = callbacks;
  }

  get layout() { return this.#layout; }
  get outcome() { return this.#outcome; }

  /** One outcome: the line above the hint, and into NOTICES when there is a ring. Drawn at once. */
  report(text) {
    if (!text || this.#isStopped()) return;
    this.#outcome = text;
    this.#notices?.add(text);
    this.#repaint();
  }

  /** A start that was accepted ends when its worker is in the process list: "X is running". */
  noteArrivals(processes) {
    const pending = this.#pendingStart;
    const arrived = pending && (processes ?? []).find((row) =>
      row?.label === pending.id || (pending.name && row?.label === pending.name));
    if (!arrived) return;
    this.#outcome = `${pending.name || pending.id} is running`;
    this.#notices?.add(this.#outcome);
    this.#pendingStart = null;
  }

  /**
   * What one handled key asks for. `leave` is true when the view is being left, so the rest of the read is not acted
   * on; `forgetFrame` asks for the next frame to be written whole.
   * @returns {{leave: boolean, forgetFrame: boolean}}
   */
  act({ quit, interrupt, toPty, action, perform, startAgent, spaceAgent, refusal }) {
    const { onQuit, onInterrupt, onAction, onStartList, onStartAgent, onSetHerdrSpace, onInput } = this.#callbacks;
    const session = this.#session;
    // A REFUSED ATTACH SAYS WHY (external review, T2): it was returned and never read, so Enter on a narrow terminal did
    // nothing and said nothing.
    if (action === "attach-refused") this.report(refusal);
    // `v` SWITCHES THE AGENTS COLUMNS and keeps the choice, so the next view opens the same way. A file the operator
    // wrote that has problems is never rewritten: the switch still applies now, and the reason it was not kept is said.
    if (action === "columns-toggle") this.#changeLayout({ extended: !this.#layout.extended });
    // THE NEXT ROW ORDER (`o`, 0.9.7), kept the same way and under the same rule. Cycled through ROW_SORTS' own keys.
    if (action === "sort-toggle") {
      const sorts = Object.keys(ROW_SORTS);
      this.#changeLayout({ sort: sorts[(sorts.indexOf(this.#layout.sort) + 1) % sorts.length] });
    }
    // A PANE'S LETTER IN THE PANE MENU collapses or expands it, kept the same way and under the same rule.
    if (String(action || "").startsWith("collapse:")) {
      const pane = action.slice("collapse:".length);
      // A PANE DRAWN ▹ IS ALREADY OPEN, and the screen has no room for it (0.9.10). Flipping it would collapse it, the
      // opposite of what was asked, and the screen would not change either way: a key that silently does nothing. So
      // this says why, and how to make the room, and leaves the layout alone.
      if (this.#noRoom().has(pane)) {
        this.report(`${pane.toUpperCase()} has no room on this screen: collapse another pane (c, then its letter) or make the window taller`);
      } else {
        // Into whichever list flips it: `collapsed`, or `expanded` for a pane that starts collapsed (lib/tui-layout.mjs).
        const { layout, written } = toggleCollapsed(this.#layout, pane);
        this.#changeLayout(layout, written);
      }
    }
    // OPENING THE LIST ASKS FOR IT. Not awaited: this runs inside a `data` listener and a slow service must not hold
    // the keyboard. The screen says it is asking until an answer lands, which is why an unanswered list cannot be drawn
    // as an empty one.
    //
    // ONLY THE ANSWER TO THIS OPENING (v0.7.1 review, W12): one that lands after a reopen is dropped.
    if (action === "start-open" && onStartList) {
      const opening = session.startOpening;
      const current = () => session.startOpening === opening;
      Promise.resolve(onStartList())
        .then((answer) => {
          if (!current()) return;
          session.noteStartable(answer?.agents, answer?.problem, answer?.service, answer?.skipped);
          this.#repaint();
        })
        .catch((error) => {
          // A REFUSAL IS AN ANSWER. Reporting it as one is what stops the screen saying "asking" for ever after a
          // service went away mid-request.
          if (!current()) return;
          session.noteStartable([], String(error?.message || error));
          this.#repaint();
        });
    }
    // TAB IN THE START LIST switches the highlighted agent's herdr space, stored by the service for its next start. The
    // row is updated in place on success so the list says so at once.
    if (spaceAgent && onSetHerdrSpace) {
      const show = spaceAgent.herdrSpace === false;
      const name = spaceAgent.name || spaceAgent.id;
      Promise.resolve(onSetHerdrSpace(spaceAgent, show))
        .then((result) => {
          if (result?.ok === false) return this.report(`herdr space for ${name} not changed: ${result.problem || "no reason given"}`);
          spaceAgent.herdrSpace = show;
          this.report(show ? `${name} gets a herdr space from its next start` : `${name} starts without a herdr space from its next start`);
        })
        .catch((error) => this.report(`herdr space for ${name} not changed: ${error?.message || error}`));
    }
    // AND CHOOSING ONE STARTS IT, through the caller for the same reason `perform` goes there: the daemon can reach its
    // own plugin, a `tui` client has to ask over HTTP.
    //
    // AND WHAT HAPPENED IS REPORTED (v0.7 scan, F9). The answer used to be dropped, so a start the service refused
    // looked exactly like one that was on its way.
    if (startAgent && onStartAgent) {
      Promise.resolve(onStartAgent(startAgent))
        .then((result) => {
          this.#pendingStart = result?.started === true ? startAgent : null;
          this.report(startOutcomeNotice(startAgent, result));
        })
        .catch((error) => this.report(startOutcomeNotice(startAgent,
          { started: false, problem: String(error?.message || error) })));
    }
    // A CONFIRMED ACTION GOES TO THE CALLER, never performed here. What `stop` MEANS differs between the two callers of
    // this view -- the daemon can reach its own runner, a `tui` client has to ask over HTTP -- which is the same split
    // `quit` and `interrupt` already use.
    //
    // A CALLER THAT SUPPLIED NO HANDLER GETS THE MENU AND NOT THE ACTIONS. That is the honest shape while the handlers
    // are being built: the operator sees what is coming, nothing happens, and nothing pretends to have happened. It is
    // also why this is not `?? onQuit` -- there is no sensible fallback for "stop this agent".
    //
    // CALLED SYNCHRONOUSLY, as it always was, and its answer reported like a start's (F9).
    if (perform && onAction) {
      let outcome;
      try {
        outcome = onAction(perform);
      } catch (error) {
        outcome = { ok: false, problem: String(error?.message || error) };
      }
      Promise.resolve(outcome)
        .then((result) => this.report(actionOutcomeNotice(perform, result)))
        .catch((error) => this.report(actionOutcomeNotice(perform,
          { ok: false, problem: String(error?.message || error) })));
    }
    // FALLS BACK TO `onQuit`, so a caller that only knows about quitting behaves exactly as it did before this split
    // existed. A caller that wants the two separated says so.
    if (interrupt) {
      (onInterrupt ?? onQuit)?.();
      return { leave: true, forgetFrame: false };
    }
    if (quit) {
      onQuit?.();
      return { leave: true, forgetFrame: false };
    }
    // `toPty` is handed back rather than written from in here, because writing to a process is the daemon's business
    // and this is a view. The binary decides.
    if (toPty !== null) onInput?.(session.selected, toPty);
    // A FULL REPAINT ON REQUEST (Ctrl+L): every terminal program binds it, and until it existed there was no way to
    // recover a smeared screen short of restarting the view.
    return { leave: false, forgetFrame: action === "repaint" };
  }

  /** Apply a layout change now, keep it in ~/.aify/tui.json, and say why when it was not kept. */
  #changeLayout(change, written = change) {
    this.#layout = { ...this.#layout, ...change };
    const kept = this.#writeLayout(written);
    if (!kept.written) this.report(kept.problem);
    this.#repaint();
  }
}
