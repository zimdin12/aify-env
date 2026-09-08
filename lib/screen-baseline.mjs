// When a reconstructed screen can be trusted, and when it must say it cannot.
//
// THE PROBLEM, traced by review through the real feed. The daemon keeps a CAPPED SUFFIX of a
// process's output and replays it to a new subscriber. That is fine for a LOG -- you lose old lines
// and read the rest -- and it is not fine for a SCREEN. A terminal's picture is built by positioning
// and overwriting, so the bytes that fell off the front carry cursor moves, SGR state, mode changes
// and geometry history that the surviving suffix cannot reconstruct. Feed a truncated suffix to an
// emulator and it produces a screen: coherent-looking, authoritative-looking, and possibly wrong.
//
// THE TWO HONEST OPTIONS were: refuse to draw until a valid baseline exists, or maintain a
// checkpoint in the daemon so a subscriber always gets one. The second changes the FEED and is its
// own piece of work. This is the first.
//
// SO WHAT IS A VALID BASELINE? Not "the replay was complete" alone, because on a long-running agent
// it never is -- that rule would refuse the console forever, which is the operator asking for a
// feature and being handed a permanent notice.
//
// A FULL-SCREEN REPAINT IS ALSO A BASELINE, and this is the whole idea. When a process clears the
// screen, everything painted before that instant stops mattering: whatever was lost is now
// irrelevant, because the picture was thrown away and drawn again. A coding agent repaints
// constantly, so the wait is seconds rather than forever -- and it is EARNED rather than assumed.
//
// THE SEQUENCES THAT COUNT, and each is here because it makes the prior screen irrelevant:
//   ESC[2J    erase the whole display
//   ESC[3J    erase the display and its scrollback
//   ESC[?1049h  switch to the alternate screen, which starts blank
//   ESCc      RIS, a full terminal reset
//
// DELIBERATELY NOT COUNTED: `ESC[H` (cursor home) and `ESC[J` (erase from the cursor DOWN). Home
// moves the cursor and erases nothing, and an erase-to-end leaves everything above the cursor exactly
// as it was -- so neither discards the lost history, and treating them as baselines would declare a
// screen trustworthy on the strength of a cursor move. `ESC[1J` (erase UP to the cursor) is out for
// the mirror-image reason. This is the one place where being generous would quietly reintroduce the
// defect the module exists to prevent.

const ESC = String.fromCharCode(27);

/**
 * The sequences that make everything painted before them irrelevant.
 *
 * MATCHED AS LITERAL TEXT, not by a regex over parameters. `ESC[2J` and `ESC[02J` are the same
 * instruction to a terminal, and this list does not claim otherwise -- it claims only that seeing one
 * of these IS a repaint. Missing a variant costs a later baseline, which is a delay; accepting
 * something that is not a repaint costs a wrong screen presented as right. The failure directions are
 * not symmetric, so this errs toward waiting.
 */
export const FULL_REPAINTS = Object.freeze([
  `${ESC}[2J`,
  `${ESC}[3J`,
  `${ESC}[?1049h`,
  `${ESC}c`,
]);

/** Whether this text contains something that discards the whole prior screen. */
export function hasFullRepaint(text) {
  const raw = String(text ?? "");
  return FULL_REPAINTS.some((sequence) => raw.includes(sequence));
}

/**
 * Whether a screen built from this stream can be shown as the truth.
 *
 * Two ways to be sound, and they are genuinely different claims:
 *
 *   THE HISTORY WAS COMPLETE. Nothing was lost, so replaying it reproduces exactly what the process
 *   painted. This is the case for a young process, and it is sound from the first byte.
 *
 *   A FULL REPAINT ARRIVED SINCE. Something was lost, but the process has since thrown the screen
 *   away and drawn it again, so the loss no longer bears on what is displayed.
 *
 * UNKNOWN META IS NOT SOUND. A daemon too old to send a `meta` frame tells us nothing about whether
 * its replay was complete, and "no evidence" must not read as "fine" -- that is the false green this
 * codebase keeps finding. Such a stream becomes sound the moment it repaints, like any other.
 *
 * @param {{truncated?: boolean}|null} meta what the producer declared, or null if it declared nothing
 * @param {boolean} repaintedSince whether a full repaint has arrived since this screen was created
 */
export function baselineIsSound(meta, repaintedSince) {
  if (repaintedSince === true) return true;
  return meta ? meta.truncated === false : false;
}

/**
 * Why a screen is not yet trustworthy, in words an operator can act on, or "" when it is.
 *
 * IT NAMES THE WAIT, not the mechanism. "Waiting for a repaint" tells somebody the console is coming;
 * "truncated replay buffer" tells them a fact about a ring buffer they did not ask about. The one
 * thing it must never do is stay silent, because a blank pane and a pane that cannot speak look the
 * same.
 */
export function baselineProblem(meta, repaintedSince) {
  if (baselineIsSound(meta, repaintedSince)) return "";
  if (!meta) return "waiting for the first repaint — this daemon does not report its history";
  return "waiting for the first full repaint — earlier output was dropped, so the screen so far is incomplete";
}
