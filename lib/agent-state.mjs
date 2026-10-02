// What an agent is doing, decided once, here (0.9 plan P0 C3; aify-comms docs/superpowers/plans/2026-10-02-aify-env-owns-agent-state-P0.md).
//
// TWO PURE FUNCTIONS, no clock, no file, no process. The host gathers the observations; these say what they mean.
//   turnIsStillLive  the turn law, ported from aify-comms `turn_liveness_policy.turn_is_still_live` with its
//                    parameters, so a turn holds here exactly as long as it holds there today
//   deriveAgentState the one word, from C3's table, first match wins
// Which turn an event may touch, and in what order, is lib/turn-events.mjs.
//
// The two ports are checked against the Python they replace: tests/fixtures/agent-state-law.json is one table of
// cases that this repo's test runs here, and aify-comms' test runs through the Python functions.

/** The strict window, as aify-comms has it (`TURN_BUSY_BACKSTOP_SECONDS = 30 * 60`). */
export const STRICT_TURN_MS = 30 * 60 * 1000;

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
  // FAILS CLOSED. A fact outside its vocabulary decides nothing: read as absent, a missing `verified` made a running
  // process `available`, which offers a second start.
  if (!factsAreRecognised(f)) return { state: "unknown", cause: "unrecognised" };
  if (f.stoppedByOperator) return { state: "stopped", cause: "operator-stop" };
  if (f.conflict) return { state: "unknown", cause: "conflict" };
  const runningVerified = f.process === "running" && f.verified === "yes";
  // Row 2 needs NO running process: one whose identity is unknown may be running, so it is row 3's, not a config fault.
  const mayBeRunning = f.process === "unknown" || (f.process === "running" && f.verified !== "no");
  if ((f.definition === "invalid" || f.definition === "unavailable") && !mayBeRunning) {
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

/** Each fact's vocabulary, as the @param list above states it. */
const FACT_WORDS = {
  definition: ["valid", "invalid", "unavailable", "none"],
  mode: ["managed", "resident"],
  process: ["running", "starting", "exited", "none", "unknown"],
  verified: ["yes", "no", "unknown"],
};
const FACT_FLAGS = ["stoppedByOperator", "startingInWindow", "conflict", "busy", "awaitingInput"];

function factsAreRecognised(f) {
  if (!Object.entries(FACT_WORDS).every(([name, words]) => words.includes(f[name]))) return false;
  if (!FACT_FLAGS.every((name) => typeof f[name] === "boolean")) return false;
  if (!Number.isSafeInteger(f.backgroundShells) || f.backgroundShells < 0) return false;
  return f.screen === null || (typeof f.screen?.state === "string" && typeof f.screen.fresh === "boolean");
}
