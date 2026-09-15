// Which lanes are producing and which have gone quiet, from the PTY and nothing else.
//
// THE ONLY STATUS THE HOST CORE MAY DERIVE. herdr's own rule is "PTY activity is the working
// authority; screen patterns corroborate". The rule for this repo, as the operator amended it on
// 2026-09-14: the host core stays PTY-only -- it exposes screen text and PTY activity, never what a
// runtime's screen MEANS -- and a service's screen knowledge may live in that service's own plugin
// directory, `lib/plugins/<service>/`, because the plugin runs next to the authoritative screen.
// (The 2026-09-03 ruling, made after screen patterns were added to the host core to unblock a fleet,
// put that knowledge in aify-comms' `console_prompts.py`; the amendment keeps the core out of it and
// lets the plugin carry it.) aify-comms' plugin does, in `lib/plugins/aify-comms/screen-rules.mjs`.
//
// SO THERE IS NO `blocked` HERE, and its absence is the design rather than a gap. Telling "waiting
// for the model" from "waiting for a human" needs to know what a claude confirmation dialog looks
// like, which the core does not know. The aify-comms plugin reports it for the terminals it runs.
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
