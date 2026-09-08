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

//: The pane's title and the rule under it, spent before any body. Named because two places need
//: the same number: the composer subtracting it, and the predicate deciding whether anything is
//: left to draw. Two literals is how a 120x1 terminal came to report a rendered pane.
export const PANE_HEADER_ROWS = 2;

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
  // WHETHER YOUR KEYBOARD IS INSIDE THIS PROCESS, which is the most consequential thing this header
  // can say and the one it did not.
  //
  // `console-session.mjs` has set `pane.attached` since the pane existed and NOTHING READ IT --
  // `grep -rn "\.attached" lib/ bin/` returned two comments and no code, both written in the past
  // tense as though the field were consumed. So an attached pane and a watched one were
  // byte-identical here, and on a wide screen the pane is where the eye is: the only signal was a
  // one-character glyph in the far-left column of the OTHER pane.
  //
  // A declared field with no reader changes nothing. This repo has been caught by that shape four
  // times in two days, and this is the fifth.
  const attached = pane?.attached === true ? " · typing here" : "";
  // AND WHETHER YOU ARE SEEING THE WHOLE PICTURE. A screen is emulated at the PRODUCER's width --
  // it has to be, because identical bytes wrap differently at a different width -- so a 132-column
  // agent in a 60-column pane is genuinely cropped, and the right-hand side of every row is missing.
  //
  // SILENT WHEN IT FITS, so the ordinary case gains no furniture. When it does not fit, an operator
  // reading a truncated line needs to know the line is truncated rather than that the agent stopped
  // mid-word -- which is exactly the misreading the old line-buffer pane produced and this whole
  // feature exists to end.
  const producerCols = Number(pane?.screenCols) || 0;
  const cropped = producerCols > 0 && width > 0 && producerCols > width
    ? ` · ${producerCols} cols, cropped`
    : "";
  // AND WHETHER IT MEASURES COLUMNS THE WAY THE PRODUCER'S TERMINAL DOES. `addon-unicode11` is
  // separately optional: without it the screen measures at Unicode 6, where a wide character is one
  // cell rather than two, and everything after it sits in the wrong column. A partial install is the
  // easiest of the three states to end up in and the only one with no error to notice.
  //
  // SILENT WHEN IT MATCHES, like the crop note. An empty version is a pane with no emulator at all,
  // which already says so in its body.
  const unicode = pane?.screenUnicode && pane.screenUnicode !== "11"
    ? ` · unicode ${pane.screenUnicode}, columns may differ`
    : "";
  return clipToWidth(`${mark} ${label}${exit}${attached}${cropped}${unicode}`, width);
}

/**
 * How many columns the DASHBOARD actually gets, which is not the terminal's width when a pane is open.
 *
 * THE CALLER HAS TO ASK BEFORE IT RENDERS. `composeConsole` receives the dashboard already drawn, so
 * it could only ever CUT what it was handed -- and it was handed a full-width frame. At the pane's
 * own minimum of 80 columns the left half is 40, so `io`, `up` and `title` vanished entirely, the
 * header read `SERVI`, the endpoint read `http://` and every heading rule was cut mid-rule. It looked
 * like a broken layout rather than a narrow one.
 *
 * DERIVED FROM THE SAME ARITHMETIC the split uses, and exported so there is one answer rather than
 * two that agree until somebody changes the divider.
 */
export function dashboardColumns(columns, hasPane) {
  const width = Math.max(0, Math.floor(columns) || 0);
  if (!hasPane || width < MIN_COLUMNS_FOR_PANE) return width;
  return Math.max(20, Math.floor(width / 2));
}

/**
 * The whole screen: the dashboard, and a console beside it when there is one to show.
 *
 * @param {{dashboardLines: string[], pane: object|null, columns: number, rows: number}} view
 * @returns {string[]}
 */
/**
 * Whether a pane will actually be put on the screen at this width.
 *
 * ONE ANSWER, ASKED BY BOTH SIDES. `composeConsole` decides this on its way to building the frame,
 * and `dashboard.mjs` has to report the same fact to the session so input can be gated on it. Two
 * places deriving it independently is how they come to disagree -- and the disagreement that matters
 * is the one where the compositor DROPS the pane while the reporter says it drew one, because then
 * keystrokes flow into a process with nothing on screen.
 *
 * NOT THE SAME QUESTION AS `session.pane()`. That says the session HAS a pane to show; this says the
 * layout will show it. A narrow terminal makes them disagree, which is exactly the case review
 * reproduced.
 */
export function paneWillBeDrawn(pane, columns, rows = Infinity) {
  if (!pane) return false;
  // HEIGHT COUNTS TOO. `composeConsole` spends two rows on the pane's title and its rule before any
  // body, so a 120x1 terminal draws a HEADER and no content -- and readiness computed from width
  // alone called that a rendered pane and let input through. Review measured exactly that.
  const height = Math.max(0, Math.floor(rows) || 0);
  if (Number.isFinite(rows) && height - PANE_HEADER_ROWS <= 0) return false;
  const width = Math.max(0, Math.floor(columns) || 0);
  // NO SEPARATE MINIMUM-WIDTH CHECK. One was written here and NO MUTANT COULD KILL IT:
  // `dashboardColumns` returns the FULL width below the minimum, which makes the remaining space
  // zero or negative, so the arithmetic already answers false. A second rule that cannot be made to
  // fail is one that can silently stop agreeing with the first.
  return rightPaneWidth(width, dashboardColumns(width, true)) > 0;
}

export function composeConsole({
  dashboardLines = [], pane = null, columns = 100, rows = 24,
  // OFF UNLESS ASKED, like every other colour decision in this view. `panes.mjs` guarantees it emits
  // no escapes of its own, so a piped or `--once` render carries exactly what its inputs carried --
  // and an emulated screen is the one input that can produce escapes without being told to.
  color = false,
} = {}) {
  const left = Array.isArray(dashboardLines) ? dashboardLines : [];
  // NEVER TALLER THAN THE SCREEN, whatever else happens. `renderDashboard` windows its table to fit,
  // but the fixed furniture -- headings, services, health, traffic -- has a floor: a 5-row terminal
  // cannot show this view at any process count. `frameUpdate` addresses rows absolutely and the
  // terminal CLAMPS the cursor, so every line past the last one is written onto the last one in
  // turn: the bottom row churns and the diff's model of the screen is wrong from then on. Cutting is
  // the honest failure; corrupting the display is not.
  const fit = (lines) => {
    const height = Math.max(0, Math.floor(rows) || 0);
    return height && lines.length > height ? lines.slice(0, height) : lines;
  };
  if (!pane) return fit(left);

  // TOO NARROW IS NOT AN ERROR, it is a one-column screen. Squeezing a pane into fifteen characters
  // produces two unreadable columns instead of one readable one, and an operator who resized their
  // window did not ask for a failure.
  const width = Math.max(0, Math.floor(columns) || 0);
  // THROUGH THE SAME PREDICATE the dashboard reports with, so "did it draw a pane" has one answer.
  if (!paneWillBeDrawn(pane, width)) return left;

  const leftWidth = dashboardColumns(width, true);
  const paneWidth = rightPaneWidth(width, leftWidth);

  // THE PANE IS SIZED TO THE SCREEN, not to its content, and the header and its rule are part of that
  // budget. Asking the follower for more lines than fit would scroll the dashboard beside it off the
  // top -- the two columns share one screen, so one of them growing is the other one shrinking.
  const height = Math.max(0, Math.floor(rows) || 0);
  const bodyHeight = Math.max(0, height - PANE_HEADER_ROWS);
  const body = typeof pane.lines === "function"
    ? pane.lines({ height: bodyHeight, width: paneWidth, color })
    : [];

  const right = [
    paneTitle(pane, paneWidth),
    "-".repeat(Math.min(paneWidth, 40)),
    ...body,
  ];
  return fit(sideBySide(left, right, { columns: width, leftWidth }));
}
