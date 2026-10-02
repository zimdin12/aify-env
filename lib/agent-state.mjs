// What an agent is doing, decided once, here (0.9 plan P0 C3; aify-comms docs/superpowers/plans/2026-10-02-aify-env-owns-agent-state-P0.md).
//
// THREE PURE FUNCTIONS, no clock, no file, no process. The host gathers the observations; these say what they mean.
//   turnIsStillLive  the turn law, ported from aify-comms `turn_liveness_policy.turn_is_still_live` with its
//                    parameters, so a turn holds here exactly as long as it holds there today
//   acceptTurnEvent  the ordering of hook events, ported from aify-comms `hook_event_order.accept_hook_event`, with
//                    "the agent's registered host" expressed as "the agent's current lifetime"
//   deriveAgentState the one word, from C3's table, first match wins
//
// The two ports are checked against the Python they replace: tests/fixtures/agent-state-law.json is one table of
// cases that this repo's test runs here, and aify-comms' test runs through the Python functions.

/** The strict window, as aify-comms has it (`TURN_BUSY_BACKSTOP_SECONDS = 30 * 60`). */
export const STRICT_TURN_MS = 30 * 60 * 1000;
/** A screen observation older than this decides nothing (aify-comms `HOST_ACTIVITY_FRESH_SECONDS`). */
export const SCREEN_FRESH_MS = 75 * 1000;

/**
 * Should this turn still count as running? Epoch milliseconds throughout; a 0 is "no timestamp".
 *
 * A verified claim ages against the more recent of its start and its last renewal, never a renewal from the future
 * or one older than the start. Anything unverified ages against the start alone. No anchor at all is not a turn. A
 * negative age (a clock-skewed write) never holds. The window is inclusive.
 */
export function turnIsStillLive({ startedAt = 0, touchedAt = 0, renewable = false, now, strictMs = STRICT_TURN_MS }) {
  let seen;
  if (renewable) {
    const usableTouch = touchedAt && touchedAt <= now ? touchedAt : 0;
    seen = Math.max(usableTouch, startedAt || 0);
  } else {
    seen = startedAt || touchedAt || 0;
  }
  if (!seen) return false;
  const age = now - seen;
  return age >= 0 && age <= strictMs;
}

/**
 * Apply a hook event, or refuse it. `last` is the last applied event of this agent ({at, lifetime}) or null;
 * `current` is the lifetime the agent is adopted under now ("" while unknown).
 *
 * @returns {{accept: boolean, last: {at: number, lifetime: string}|null, reason: string}}
 */
export function acceptTurnEvent(last, event, current) {
  const at = event?.firedAtUs;
  if (!Number.isSafeInteger(at) || at <= 0) return { accept: true, last, reason: "outside-ordering" };
  const lifetime = String(event?.lifetime || "");
  // The registered-host check: an event from a lifetime other than the current one cannot apply. An event that
  // names no lifetime (a launcher from before 0.9) or an agent with none adopted yet is not refused by it, as a
  // hook naming no machine is not refused today.
  if (lifetime && current && lifetime !== current) return { accept: false, last, reason: "other-lifetime" };
  const next = { at, lifetime };
  if (!last) return { accept: true, last: next, reason: "first" };
  if (lifetime !== last.lifetime) return { accept: true, last: next, reason: "first-of-lifetime" };
  if (at > last.at) return { accept: true, last: next, reason: "later" };
  if (at === last.at && event.kind === "turn-end") return { accept: true, last: next, reason: "end-wins-tie" };
  return { accept: false, last, reason: "out-of-order" };
}

/**
 * The agent's one word, and the rule that decided it (P0 C3).
 *
 * @param {object} facts
 * @param {boolean} facts.stoppedByOperator
 * @param {"valid"|"invalid"|"unavailable"|"none"} facts.definition  "unavailable": its harness is not installed
 * @param {"managed"|"resident"} facts.mode
 * @param {"running"|"starting"|"exited"|"none"|"unknown"} facts.process
 * @param {"yes"|"no"|"unknown"} facts.verified
 * @param {boolean} facts.startingInWindow
 * @param {boolean} facts.conflict   two verified lifetimes, or one agent from two instances (C4)
 * @param {boolean} facts.busy       the turn law's answer
 * @param {boolean} facts.awaitingInput
 * @param {{state: string, fresh: boolean}|null} facts.screen
 * @param {number} facts.backgroundShells
 * @returns {{state: string, cause: string}}
 */
export function deriveAgentState(facts) {
  const f = facts || {};
  if (f.stoppedByOperator) return { state: "stopped", cause: "operator-stop" };
  if (f.conflict) return { state: "unknown", cause: "conflict" };
  const runningVerified = f.process === "running" && f.verified === "yes";
  if ((f.definition === "invalid" || f.definition === "unavailable") && !runningVerified) {
    return { state: "misconfigured", cause: "config" };
  }
  if (f.process === "unknown" || (f.process === "running" && f.verified === "unknown")) {
    return { state: "unknown", cause: "identity-unknown" };
  }
  if (runningVerified) {
    const screen = f.screen?.fresh ? f.screen.state : "";
    if (screen === "working" || screen === "blocked") return { state: screen, cause: "screen" };
    if (f.busy) return { state: f.awaitingInput ? "blocked" : "working", cause: "turn-open" };
    if (screen === "shell" || (f.backgroundShells || 0) > 0) return { state: "shell", cause: "at-prompt" };
    return { state: "idle", cause: "at-prompt" };
  }
  if (f.process === "starting" && f.startingInWindow) return { state: "starting", cause: "starting" };
  if (f.mode === "managed" && f.definition === "valid") return { state: "available", cause: "startable" };
  return { state: "offline", cause: "absent" };
}
