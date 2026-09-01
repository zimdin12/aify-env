// What the screen looks like when a console is open beside the dashboard.
//
// THE LAST PURE PIECE. `panes.mjs` puts two columns side by side, `output-follower.mjs` says what one
// process is doing, and this decides whether there is a second column at all, what heads it, and how
// wide it gets. Keeping that here rather than in the render loop means the whole layout is decided by
// a function that takes values and returns lines -- so a screen can be asserted without a terminal,
// which is the only way the alignment rules below are testable at all.

import { clipToWidth, rightPaneWidth, sideBySide } from "./panes.mjs";
import { CONNECTING, EXITED, FAILED, GONE, STREAMING } from "./output-follower.mjs";

/** Below this, a second column cannot hold anything worth reading, so there is only one. */
export const MIN_COLUMNS_FOR_PANE = 80;

/**
 * A one-character mark for a follower's state.
 *
 * A GLYPH, NOT A COLOUR. The pane header has to work in a pipe, in a screen reader, and for the
 * operator who cannot tell this terminal's red from its yellow -- and colour is applied a layer up
 * anyway, where it can be turned off. So the state is carried by a character that survives all three.
 */
export function statusMark(status) {
  if (status === STREAMING) return ">";
  if (status === EXITED) return ".";
  if (status === GONE) return "?";
  if (status === FAILED) return "!";
  if (status === CONNECTING) return "~";
  return " ";
}

/**
 * The line that names what a pane is showing.
 *
 * IT NAMES THE PROCESS AND ITS STATE, always. A pane with no header is a wall of text whose owner an
 * operator has to remember, and the whole reason for a side-by-side view is watching one thing while
 * the other keeps moving.
 */
export function paneTitle(pane, width) {
  const mark = statusMark(pane?.status);
  const label = String(pane?.label || pane?.id || "(unclaimed)");
  const exit = pane?.exit
    ? ` exit ${pane.exit.code === null ? `signal ${pane.exit.signal ?? "?"}` : pane.exit.code}`
    : "";
  return clipToWidth(`${mark} ${label}${exit}`, width);
}

/**
 * The whole screen: the dashboard, and a console beside it when there is one to show.
 *
 * @param {{dashboardLines: string[], pane: object|null, columns: number, rows: number}} view
 * @returns {string[]}
 */
export function composeConsole({ dashboardLines = [], pane = null, columns = 100, rows = 24 } = {}) {
  const left = Array.isArray(dashboardLines) ? dashboardLines : [];
  if (!pane) return left;

  // TOO NARROW IS NOT AN ERROR, it is a one-column screen. Squeezing a pane into fifteen characters
  // produces two unreadable columns instead of one readable one, and an operator who resized their
  // window did not ask for a failure.
  const width = Math.max(0, Math.floor(columns) || 0);
  if (width < MIN_COLUMNS_FOR_PANE) return left;

  const leftWidth = Math.max(20, Math.floor(width / 2));
  const paneWidth = rightPaneWidth(width, leftWidth);
  if (paneWidth <= 0) return left;

  // THE PANE IS SIZED TO THE SCREEN, not to its content, and the header and its rule are part of that
  // budget. Asking the follower for more lines than fit would scroll the dashboard beside it off the
  // top -- the two columns share one screen, so one of them growing is the other one shrinking.
  const height = Math.max(0, Math.floor(rows) || 0);
  const bodyHeight = Math.max(0, height - 2);
  const body = typeof pane.lines === "function" ? pane.lines({ height: bodyHeight, width: paneWidth }) : [];

  const right = [
    paneTitle(pane, paneWidth),
    "-".repeat(Math.min(paneWidth, 40)),
    ...body,
  ];
  return sideBySide(left, right, { columns: width, leftWidth });
}
