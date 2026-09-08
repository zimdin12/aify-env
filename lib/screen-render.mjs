// The lines a pane draws for one emulated screen.
//
// PURE, AND IT KNOWS NOTHING ABOUT xterm. It takes rows that have already been read out of an
// emulator and returns what the pane should print. That is the whole seam: `screen-emulator.mjs` owns
// the dependency and the buffer arithmetic, this file owns the shaping, and shaping is the half with
// rules worth arguing about. Written against literals rather than a fake buffer, because a fake is a
// second implementation of the thing under test and this needs none.
//
// WHY A SCREEN IS NOT A LOG, which is the distinction the whole feature turns on. `pane-buffer.mjs`
// keeps the LAST N lines a process printed -- correct for something that prints, useless for something
// that paints. A coding agent paints: it positions the cursor, erases, and overwrites, so its output
// has no line order to keep. What it has is a grid, and a grid is read from the TOP.
//
// SO TRAILING BLANKS GO AND LEADING BLANKS STAY. Dropping empty rows off the BOTTOM costs nothing --
// a 20-row screen with five rows of content has fifteen rows of nothing, and printing them tells the
// reader nothing while filling the pane. Dropping them off the TOP would move the content, and
// vertical position is meaning here: an agent's status line sits where it sits. The asymmetry is the
// point, and it is the one rule in this file somebody could get backwards.

import { clipToWidth } from "./panes.mjs";

/** A row with nothing on it. Whitespace-only counts: a painted screen is full of spaces, not "". */
function isBlankRow(row) {
  return String(row ?? "").trim() === "";
}

/**
 * What the pane prints for this screen.
 *
 * @param {string[]} rows the emulator's rows, top first, already read
 * @param {{width?: number, height?: number}} size the pane's grid
 * @returns {string[]} at most `height` lines, each at most `width` columns
 */
export function screenLines(rows, { width = 80, height = 24 } = {}) {
  const cols = Math.max(0, Math.floor(width) || 0);
  const limit = Math.max(0, Math.floor(height) || 0);
  if (!cols || !limit) return [];

  const all = Array.isArray(rows) ? rows : [];
  // FROM THE TOP, and this is a CROP of a bigger picture rather than a screen that happened to fit.
  // The emulator runs at the PRODUCER's geometry, never the pane's, and the pane takes what it can
  // show. Sizing it to the pane instead was the first design here and review killed it with a
  // measurement: identical bytes at 80 and 40 columns do not merely clip differently, they WRAP --
  // a row-1 overflow lands on row 2 and collides with the text that belongs there, so a narrow
  // emulator does not show less of the screen, it shows a different and wrong one.
  //
  // WHICH PART TO CROP IS STILL OPEN and belongs to the caller, not here. The top is what a reader
  // starts from, but a coding agent's live edge is usually its BOTTOM rows. This function takes what
  // it is given and does not guess.
  const visible = all.slice(0, limit);

  let last = visible.length;
  while (last > 0 && isBlankRow(visible[last - 1])) last -= 1;

  // CLIPPED WITH THE SAME FUNCTION THE REST OF THE PANE USES, so a wide character or an SGR run costs
  // the same number of columns here as it does in every other row of this view. Measuring width with
  // `.length` is how a pane ends up one character wider than its column and shifts every line below it.
  return visible.slice(0, last).map((row) => clipToWidth(String(row ?? ""), cols));
}

/**
 * Whether this screen has nothing on it at all.
 *
 * A BLANK SCREEN IS A REAL STATE, not a failure: an agent that just cleared the screen has painted
 * exactly this, and so has one that has started but not yet drawn. The caller needs to tell it apart
 * from "no screen" so it can say something true instead of showing an empty pane, which reads as
 * broken. Answered from the ROWS rather than from `screenLines`, because a screen whose only content
 * sits below the pane's height is blank to the reader and not to the emulator, and conflating those
 * would report "empty" for a picture that exists.
 */
export function screenIsBlank(rows) {
  const all = Array.isArray(rows) ? rows : [];
  return all.every(isBlankRow);
}
