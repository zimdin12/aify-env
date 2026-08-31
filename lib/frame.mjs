/**
 * Turning one screen into the next by writing only what changed.
 *
 * WHY THE FULL CLEAR HAD TO GO. The loop wrote `ESC[2J ESC[H` and then the whole frame, twice a
 * second. On a real terminal that is a blank screen followed by a repaint, and the eye sees it as
 * flicker -- every row is destroyed and recreated whether or not a single character differs. It is
 * tolerable for a status list nobody stares at. It is unusable the moment there is a side pane with
 * live output in it, which is the whole point of the upgrade: the pane would strobe.
 *
 * It is also why the terminal cannot hold a selection or a cursor today. A cleared screen has no
 * "where you were".
 *
 * PURE, AND THAT IS WHAT MAKES IT TESTABLE. `frameUpdate` takes the previous lines and the next
 * lines and returns the bytes that turn one into the other. Nothing here reads a clock, a terminal
 * size, or `process.stdout` -- so a test can assert exactly which rows were touched, which is the
 * only property that matters and the only one a screenshot could never prove.
 */

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

/** Move the cursor to the start of a 1-indexed row. */
export const moveToRow = (row) => `${CSI}${Math.max(1, Math.trunc(row))};1H`;
/** Erase from the cursor to the end of the line -- what makes a SHORTER new line safe. */
export const ERASE_LINE = `${CSI}K`;
/** Erase from the cursor to the end of the screen -- used once, when the frame gets shorter. */
export const ERASE_BELOW = `${CSI}J`;
export const CLEAR_SCREEN = `${CSI}2J${CSI}H`;

/**
 * The bytes that turn a screen showing `previous` into one showing `next`.
 *
 * A FIRST FRAME CLEARS, and every frame after it does not. With no previous frame this code has no
 * idea what is on the screen -- there may be a shell prompt, a log line, anything -- so the one
 * honest move is to clear once and own the screen from then on. Treating an unknown screen as blank
 * is how a repaint leaves somebody's half-finished command sitting under the dashboard.
 *
 * UNCHANGED ROWS ARE NOT TOUCHED AT ALL. That is the entire optimisation and the entire reason a
 * pane can hold still: a row nobody wrote does not blink.
 *
 * @param {string[]|null} previous lines currently on screen, or null/[] for the first frame
 * @param {string[]} next lines that should be on screen
 * @returns {string} bytes to write; EMPTY when nothing changed
 */
export function frameUpdate(previous, next) {
  const before = Array.isArray(previous) ? previous : [];
  const after = Array.isArray(next) ? next : [];
  const first = before.length === 0;

  const out = [];
  if (first) {
    out.push(CLEAR_SCREEN);
    for (let row = 0; row < after.length; row += 1) {
      out.push(moveToRow(row + 1), after[row], ERASE_LINE);
    }
    // The cursor is parked below the frame rather than left mid-screen, where it would sit on top of
    // a character and look like a defect.
    out.push(moveToRow(after.length + 1));
    return out.join("");
  }

  for (let row = 0; row < after.length; row += 1) {
    if (before[row] === after[row]) continue;
    // ERASE_LINE AFTER the text, not before: writing then erasing the tail leaves no moment where
    // the row is blank, so a row that changes does not flash either.
    out.push(moveToRow(row + 1), after[row], ERASE_LINE);
  }

  if (after.length < before.length) {
    // The frame got shorter. Erasing from the first orphaned row to the bottom is one escape rather
    // than one per row, and it cannot leave a stale line from a taller frame behind -- which is
    // exactly what a naive "only write the new lines" painter does.
    out.push(moveToRow(after.length + 1), ERASE_BELOW);
  }

  if (out.length === 0) return "";
  out.push(moveToRow(after.length + 1));
  return out.join("");
}

/**
 * How many rows differ. Not used to render -- used to SAY how much a frame moved.
 *
 * A number worth having because "the dashboard is flickering" and "the dashboard is repainting one
 * row" look identical in a screenshot and are opposite diagnoses.
 */
export function changedRowCount(previous, next) {
  const before = Array.isArray(previous) ? previous : [];
  const after = Array.isArray(next) ? next : [];
  let changed = Math.abs(after.length - before.length);
  for (let row = 0; row < Math.min(before.length, after.length); row += 1) {
    if (before[row] !== after[row]) changed += 1;
  }
  return changed;
}
