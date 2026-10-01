// One loop of passes, the shape both of the aify-comms plugin's loops share.
//
// THE LOOP SURVIVES A THROWING PASS, since 2026-09-04 for the claim loop (external review, Round 8 H2)
// and 2026-09-06 for the control loop (Round 9 H2, the same defect still standing beside it).
//
// Each was `try { while ... } finally {}` with no catch, and the caller a one-shot `.catch(log)` -- so
// ONE throw anywhere in a pass ended that loop for the life of the process. Silently: the heartbeat is
// a separate loop, so `bridgeLastSeen` kept refreshing, the doctor's `claimer.accepted` kept passing,
// `/spawn` kept accepting, and the queue simply never drained, or no terminal could be started,
// stopped or typed into while every instrument read healthy.
//
// The known throws are fixed at their sources (`claim.mjs`, and `report` in `terminal-controls.mjs`,
// which now logs instead of throwing). This is the CLASS: a pass that fails for a reason nobody
// anticipated costs one interval, never the loop. The failure is recorded as `unreachable`, so the
// loop's instrument moves rather than freezing on its last good value -- an instrument that stops
// moving is worse than one that reports trouble.

/**
 * Run passes until `runs()` says no.
 *
 * @param {object} loop
 * @param {string} loop.label                 which loop, for the log ("claim", "terminal control")
 * @param {() => boolean} loop.runs           whether another pass may begin
 * @param {() => Promise<object>} loop.pass   one pass, its setup included; resolves to `{outcome, ...}`
 * @param {(result: object) => number} loop.settle  records a pass's result; returns the pause before the next
 * @param {(message: string) => void} loop.log
 * @param {Function} loop.setTimeoutImpl
 */
export async function runPasses({ label, runs, pass, settle, log, setTimeoutImpl }) {
  while (runs()) {
    let result;
    try {
      result = await pass();
    } catch (error) {
      log(`aify-comms ${label} pass failed: ${error?.message || error}`);
      result = { outcome: "unreachable" };
    }
    const pause = settle(result);
    await new Promise((resolve) => setTimeoutImpl(resolve, pause));
  }
}
