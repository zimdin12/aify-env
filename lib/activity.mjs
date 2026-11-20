// Which lanes are producing and which have gone quiet, from the PTY and nothing else.
//
// This module measures bytes and silence, not agent state. Owner decision D2 (2026-11-04,
// aify-comms#46) puts screen observation at the Runner's PTY boundary. Agent state uses that
// separate observation; dialog answer policy stays in the service plugin.
//
// WHAT THE OPERATOR GETS FROM THIS ANYWAY: on a host running nine agents, which ones are drawing.
// That is the question "I have nine lanes and I want the one that needs me" mostly reduces to, and
// it costs one timestamp per process rather than a screen model per runtime.

/**
 * How long a process may be silent and still count as working.
 *
 * MEASURED AGAINST WHAT AGENTS ACTUALLY DO. A coding-agent TUI mid-turn repaints its spinner several
 * times a second -- the live capture this repo keeps shows claude emitting a frame roughly every
 * 100ms while generating -- so three seconds is thirty missed frames, not a close call. It is long
 * enough that a slow model call between two frames does not flap the row, and short enough that a
 * finished turn reads as quiet before the operator has finished looking at the screen.
 *
 * NOT A TUNING KNOB. It is the definition of the word this module puts on screen; changing it
 * changes what `working` claims.
 */
export const WORKING_SILENCE_MS = 3000;

/** What this tier is willing to say about a process. Named so a typo is an import error. */
export const WORKING = "working";
export const QUIET = "quiet";
export const UNKNOWN = "unknown";

/**
 * The activity state of one process row.
 *
 * `unknown` IS A REAL ANSWER AND NOT A SYNONYM FOR QUIET. A process that has never emitted a byte
 * has no activity to report -- it may be seconds from its first frame -- and a daemon too old to
 * send the field says nothing at all. Reporting either as `quiet` would be a claim nothing measured,
 * which is the false-green shape both repos keep getting caught by. Three states, so a reader can
 * tell "silent" from "not measured".
 *
 * @param {{lastOutputAtMs?: number}} row a process as `/health` reports it
 * @param {number} nowMs the moment the snapshot was taken, passed in so this stays pure
 */
export function activityOf(row, nowMs) {
  const at = row?.lastOutputAtMs;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return UNKNOWN;
  // A stamp from the FUTURE is not evidence of work. Clocks move: the daemon and a reader can
  // disagree, and treating a future stamp as "working" would pin a dead lane to working for as long
  // as the skew lasts. It is unknown, which is what it is.
  if (at > nowMs) return UNKNOWN;
  return nowMs - at <= WORKING_SILENCE_MS ? WORKING : QUIET;
}
