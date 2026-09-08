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
// A FULL RESET IS ALSO A BASELINE, and this is the whole idea. When a process resets the terminal,
// everything before that instant stops mattering: whatever was lost is irrelevant, because the
// screen, the cursor, SGR and the modes were all thrown away together.
//
// THE WAIT IS NOT "SECONDS", and this paragraph said so until 2026-09-08. It said a coding agent
// repaints constantly -- true of ERASING the display, which turned out not to be a baseline at all.
// Only RIS qualifies, and an agent may go a long time without emitting one. The honest statement is
// that the wait is UNBOUNDED, and that the way out is a maintained checkpoint in the feed rather
// than a more generous rule here.
//
// ONE SEQUENCE COUNTS: `ESC c`, RIS, a full terminal reset.
//
// I FIRST ACCEPTED FOUR, AND REVIEW PROVED THREE OF THEM WRONG -- one of them by producing actual
// DISCLOSURE. Each was checked by feeding the WHOLE history to one emulator and the retained SUFFIX
// to another and comparing the screens. Measured 2026-09-08 against the real package:
//
//   ESC[2J      ERASES THE DISPLAY AND RESETS NOTHING ELSE. With an `ESC[8m` (conceal) lost off the
//               front, the oracle showed "" and the reconstruction printed SYNTHETIC_HIDDEN. The
//               pane would have displayed text the terminal was hiding -- the exact disclosure the
//               cell-level conceal handling exists to prevent, walked in through this door.
//   ESC[3J      CLEARS SCROLLBACK, NOT THE DISPLAY. Oracle kept OLD_TEXT_STILL_ON_SCREEN; the
//               reconstruction lost it.
//   ESC[?1049h  the alternate screen starts blank, but the NORMAL screen underneath was never
//               reconstructed -- and a later `ESC[?1049l` restores it. Soundness cannot be permanent
//               on the strength of a switch that can be switched back.
//
// RIS agreed with the oracle in the same run, which is why it is the one that stays. It resets the
// screen, the cursor, SGR and modes together, so nothing that fell off the front can still be in
// effect afterwards.
//
// THE COST IS REAL AND IS THE RIGHT TRADE. A coding agent may go a long time without emitting RIS, so
// a truncated stream can stay unsound for a while and the pane keeps saying so. The alternative is a
// screen that looks authoritative and is sometimes wrong, and once it can print concealed text that
// is not a display bug. The way OUT of this is to stop truncating -- a maintained checkpoint in the
// feed, which is a change to the daemon's retention and the operator's call, not something to
// approximate here.
//
// STILL DELIBERATELY NOT COUNTED, for the reason that survived: `ESC[H` moves the cursor and erases
// nothing, `ESC[J` and `ESC[1J` erase only one side of it.

const ESC = String.fromCharCode(27);

/**
 * The sequences that make everything painted before them irrelevant. Exactly one.
 *
 * THE FAILURE DIRECTIONS ARE NOT SYMMETRIC, which is the whole reason this list is short. Missing a
 * sequence costs a later baseline -- a delay, visible, recoverable. Accepting one that is NOT a full
 * reset costs a wrong screen presented as right, and in the measured ED2 case it printed concealed
 * text. So this errs toward waiting, and every addition needs the oracle-versus-suffix comparison
 * that removed the other three.
 */
export const FULL_REPAINTS = Object.freeze([`${ESC}c`]);

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
 * UNKNOWN META IS NOT SOUND BY ITSELF. A daemon too old to send a `meta` frame tells us nothing about
 * whether its replay was complete, and "no evidence" must not read as "fine". It DOES become sound on
 * a full reset, like any other stream -- `(null, true)` is true, deliberately, because RIS makes the
 * unknown history irrelevant rather than merely unmeasured. Review read the earlier wording as
 * claiming otherwise, and the wording was the thing that was wrong.
 *
 * @param {{truncated?: boolean}|null} meta what the producer declared, or null if it declared nothing
 * @param {boolean} repaintedSince whether a full repaint has arrived since this screen was created
 */
export function baselineIsSound(meta, repaintedSince) {
  if (repaintedSince === true) return true;
  // A LITERAL `false` IS THE ONLY COMPLETENESS CLAIM. Anything else -- missing, a string, null -- is
  // not one, and `=== false` already says so: an `in` check beside it could never disagree, so it was
  // removed rather than left as a second rule nobody can make fail.
  //
  // THE FAILING-CLOSED HAPPENS IN THE PARSER, which is where the coercion lived: it turned a missing
  // field into `false`, and `false` MEANS "complete". A malformed frame now arrives as `truncated:
  // true` and is unsound until a full reset, which is the answer that cannot disclose anything.
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
