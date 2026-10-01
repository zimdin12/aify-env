// What a heartbeat answer says about this host as the CLAIMER. PURE: the answer in, the plugin's
// claimer state and the line to log out.
//
// ACCEPTED IS NOT THE SAME AS DELIVERED, and believing it was cost a day on 2026-09-02. The service
// arbitrates supersession and may DISCARD a beat while answering `ok: true` -- so a 200 says the
// request was well-formed, never that this host is the claimer. Without this read, a plugin beats
// every 30s, `bridgeLastSeen` never moves, `/spawn` refuses every request, and both sides report
// healthy. That is exactly what happened.

/**
 * @param {any} answer             the heartbeat's response body
 * @param {object} context
 * @param {boolean} context.wasRefused   whether the previous answer refused this host
 * @param {string} context.ourBridgeId   this host's bridge id, or "" when the api cannot say
 * @returns {{claimer: object|null, claimRefused: boolean, lastHeartbeatError: string, logLine: string}}
 */
export function claimerFromAnswer(answer, { wasRefused = false, ourBridgeId = "" } = {}) {
  // `claimer` ABSENT means an older service that cannot answer the question; that is not a refusal
  // and must not be reported as one, or every host on a service one version back would log a fault
  // it does not have.
  const reported = answer && typeof answer === "object" ? answer.claimer : null;
  // `claimer.bridgeId` IS THE HOLDER'S, not ours -- on a refusal it names whoever owns the row. That
  // is the useful value and it is also easy to misread as our own: it cost ten minutes of wrong
  // reasoning on 2026-09-03, staring at a `/health` that showed an id matching the row and concluding
  // arbitration was refusing us over ourselves. So both travel, named.
  const claimer = reported
    ? { ...reported, holderBridgeId: reported.bridgeId || "", ourBridgeId: String(ourBridgeId || "") }
    : null;
  // THE REFUSAL IS ACTED ON, not only reported, since 2026-09-04 (external review, Round 8 M4): the
  // claim loop takes its long back-off while this is set. STATE, NOT AN EVENT, deliberately. The
  // service queues a stop for a superseded bridge in `environment_controls`, and nothing drains it --
  // the consumer was the aify-comms environment-control loop, which v0.6.2 deleted. This flag arrives
  // on every beat instead and cannot be lost.
  const claimRefused = Boolean(reported && reported.accepted === false);
  if (claimRefused) {
    return {
      claimer,
      claimRefused,
      lastHeartbeatError: `not the claimer: ${reported.reason || "refused"}`,
      // ONCE PER TRANSITION. A line every 30 seconds is how a log stops being read, and this one has
      // to still be legible on the beat where it starts.
      logLine: wasRefused ? "" : (
        `aify-comms accepted the heartbeat but did NOT accept this host as the claimer`
        + ` (holder: ${reported.bridgeId || "unknown"}; ${reported.reason || "no reason given"}).`
        + ` Spawns here will be refused until that is resolved. Standing down from claiming;`
        + ` running workers are left alone, and this host resumes automatically when it is`
        + ` accepted again.`),
    };
  }
  return {
    claimer,
    claimRefused,
    lastHeartbeatError: "",
    logLine: wasRefused ? "aify-comms accepted this host as the claimer again; resuming normal claiming." : "",
  };
}
