// The view's frame from what it was given: a snapshot, the session's view of it, the layout, the last outcome and the
// terminal's size. In: those. Out: lines. No timers, no writes, no state.

import { renderDashboard } from "../tui.mjs";
import { sortRows } from "../tui-panes/row-order.mjs";
import { composeConsole, dashboardColumns } from "../console-view.mjs";

/**
 * The snapshot IN THE ORDER ASKED FOR (`o`, 0.9.7), sorted before the session syncs, so the keys and the screen index
 * one list. A copy: a repaint draws the last snapshot again after `o`, and it must sort from what the environment sent.
 * PURE.
 */
export function orderedSnapshot(collected, sort) {
  return { ...collected, processes: sortRows(collected.processes, collected.agentRecords, sort) };
}

export class ViewRenderer {
  #color;
  #keys;
  #endsWithHerdr;

  /**
   * @param {{color: boolean, keys: {enabled: boolean, canQuit: boolean}, endsWithHerdr: boolean}} config
   *   `keys` is DERIVED FROM WHAT THE VIEW WAS ACTUALLY GIVEN, never passed in separately: the keyboard, and whether
   *   leaving is on offer, so the hint on screen cannot disagree with what the keys will do -- which is the failure a
   *   second flag would eventually produce.
   */
  constructor({ color, keys, endsWithHerdr }) {
    this.#color = color;
    this.#keys = keys;
    this.#endsWithHerdr = endsWithHerdr;
  }

  /**
   * @param {object} snapshot  the ordered snapshot, with the notices to show
   * @param {{session: object|null, layout: object, outcome: string, columns: number, rows: number}} context
   * @returns {string[]} the frame
   */
  lines(snapshot, { session, layout, outcome, columns, rows }) {
    return composeConsole({
      dashboardLines: renderDashboard(snapshot, {
        // THE WIDTH IT WILL ACTUALLY GET, asked before drawing. `composeConsole` receives the frame already rendered, so
        // handing it a full-width one and letting it cut produced a left column with `io`, `up` and `title` gone and
        // every heading rule sliced mid-rule.
        columns: dashboardColumns(columns, Boolean(session?.pane())),
        color: this.#color,
        // AND THE HEIGHT, so the process table can be windowed around the selection rather than running off the
        // bottom of a terminal that clamps every row past the last one onto it.
        rows,
        keys: this.#keys,
        endsWithHerdr: this.#endsWithHerdr,
        layout,
        // FROM THE SESSION THAT OWNS THE SELECTION, never recomputed here. Two places deriving the visible list would
        // agree until one learned about a new filter, and the symptom would be a cursor sitting on a row the keyboard
        // is not actually on.
        view: session ? {
          rows: session.visible(),
          selected: session.focus.selected,
          mode: session.focus.mode,
          query: session.focus.query,
          withoutConsole: session.withoutConsole,
          //: So the hint stops offering the console where no pane can be drawn.
          paneDrawable: session.canDrawPane(),
          //: So the hint can say "show" or "hide" rather than making the operator press it to find out.
          paneHidden: session.focus.paneHidden,
          //: And which actions this caller can perform, so the menu draws no row it cannot run.
          menuActions: session.focus.menuActions,
          menuAt: session.focus.menuAt,
          confirming: session.focus.confirming,
          //: Why an attached pane is dropping keys, so the hint agrees with the pane's title.
          inputPaused: session.pane()?.inputPaused ?? "",
          //: So the screen says what Ctrl+C does where it stops everything.
          confirmInterrupt: session.focus.confirmInterrupt === true,
          //: WHICH agent the open menu is about, so the prompt and the executor name the same one. Without it the
          //: prompt indexed the cursor while `y` acted on the bound id.
          actionTargetId: session.actionTargetId,
          //: THE AGENTS THIS HOST COULD START, from the session that owns that list too. A second derivation here
          //: would be a second answer to one question, which is how a cursor ends up on a row the keyboard is not on.
          start: session.startView(),
          outcome,
        } : null,
      }),
      pane: session?.pane() ?? null,
      //: The SAME decision the dashboard beside it made, never a second one. Two answers here is a coloured pane beside
      //: a colourless list, or escapes in a piped render.
      color: this.#color,
      columns,
      rows,
    });
  }
}
