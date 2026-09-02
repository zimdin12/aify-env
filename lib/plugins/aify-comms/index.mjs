// The aify-comms plugin: what makes this host a CLAIMER rather than only a description of one.
//
// TWO LOOPS, AND THEY ARE NOT THE SAME SHAPE.
//
// The HEARTBEAT is on a timer, because its job is to keep `metadata.bridgeLastSeen` fresh and the
// service ages that against a 90-second window. Miss it and `/spawn` refuses -- correctly -- while
// every component reports healthy, which is exactly what the operator hit on 2026-09-02.
//
// The CLAIM is a continuous long-poll, not a timer. The service holds the request open until work
// arrives, so a timer would either poll far more often than needed or add its own latency on top of
// a call already designed to wait. It re-enters as soon as the previous pass settles.
//
// STARTING MUST NOT DEPEND ON THE SERVICE BEING UP. aify-env's own job -- running processes for
// whoever asked -- does not require aify-comms to answer, and a plugin that threw on a cold service
// would take the host down with it. Both loops treat unreachable as a state to retry from, never as
// a failure to start.

import {
  CommsApi,
  CommsApiError,
  mintBridgeIdentity,
} from "./api.mjs";
import { runClaimPass } from "./claim.mjs";

/** How often to say this host is still a claimer. WELL INSIDE the service's 90-second freshness
 *  window: at 45s a single missed beat still leaves the row live, and two consecutive misses are a
 *  real outage rather than a scheduling hiccup. A value at or near the window makes every GC pause
 *  look like a dead bridge. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long to wait before trying again after the service refuses or cannot be reached. Long enough
 *  not to hammer a service that is down, short enough that recovery is not something an operator
 *  waits on -- they have already restarted things and want the fleet back. */
export const RETRY_AFTER_ERROR_MS = 5_000;

/** A FLOOR BETWEEN PASSES, however fast the service answers.
 *
 *  The claim is a long-poll: the service holds it open for `CLAIM_WAIT_MS` and the loop is meant to
 *  spend its life inside that call. But a service that answers immediately -- one that has stopped
 *  honouring `waitMs`, or an older build that never did -- turns this into a hot loop that pins a
 *  core and hammers the endpoint, and the symptom is a machine at 100% with no error anywhere.
 *
 *  FOUND BY THE FIRST TEST that ran the loop against a fake answering instantly. Nothing in
 *  production would have shown it until the day the service changed. */
export const MIN_PASS_INTERVAL_MS = 250;

/**
 * The plugin object aify-env's ServicePlugins registry runs.
 *
 * Everything it needs from the host arrives through `start(host)`; nothing is reached for globally,
 * so a test drives it with fakes and never touches a network or a real process.
 */
export function createCommsPlugin({
  endpoint,
  version = "",
  advertisement = () => ({}),
  cwdRoots = () => [],
  machineId = "",
  windows = process.platform === "win32",
  api: injectedApi = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let api = injectedApi;
  let heartbeatTimer = null;
  let claiming = false;
  let stopped = true;
  let host = null;
  //: What the last pass did, so a doctor or a TUI can say why nothing is being claimed rather than
  //: leaving an operator to infer it from silence. That inference cost a day.
  const state = { lastHeartbeat: "", lastHeartbeatError: "", lastClaim: "", claimedTotal: 0 };

  async function beat() {
    if (stopped) return;
    try {
      await api.heartbeat(await advertisement());
      state.lastHeartbeat = new Date().toISOString();
      state.lastHeartbeatError = "";
    } catch (error) {
      // NAMED, not swallowed. A host that cannot register as a claimer looks identical to one that
      // simply has no work -- and telling those apart from outside took hours on 2026-09-02.
      state.lastHeartbeatError = error instanceof CommsApiError
        ? `${error.status || "unreachable"}: ${error.message}`
        : String(error?.message || error);
      host?.log?.(`aify-comms heartbeat failed (${state.lastHeartbeatError})`);
    }
    if (!stopped) heartbeatTimer = setTimeoutImpl(beat, HEARTBEAT_INTERVAL_MS);
  }

  async function claimForever() {
    if (claiming) return;
    claiming = true;
    try {
      while (!stopped) {
        const result = await runClaimPass({
          api,
          processes: host.processes,
          environmentId: host.environmentId,
          cwdRoots: await cwdRoots(),
          windows,
          log: (message) => host?.log?.(message),
        });
        state.lastClaim = result.outcome;
        if (result.outcome === "started") state.claimedTotal += 1;
        // A LONG back-off when something is wrong; a SHORT floor otherwise. The floor is not
        // latency an operator will notice -- a spawn already crossed a network -- and it is the
        // only thing standing between a service that stops long-polling and a pinned core.
        const pause = result.outcome === "unreachable" ? RETRY_AFTER_ERROR_MS : MIN_PASS_INTERVAL_MS;
        await new Promise((resolve) => setTimeoutImpl(resolve, pause));
      }
    } finally {
      claiming = false;
    }
  }

  return {
    name: "aify-comms",

    /** For a doctor, a TUI, or a test: what this plugin is actually doing. */
    state: () => ({ ...state }),

    async start(pluginHost) {
      host = pluginHost;
      stopped = false;
      if (!api) {
        api = new CommsApi({
          endpoint,
          credential: () => host.credential(),
          identity: mintBridgeIdentity({ version }),
        });
      }
      // The first beat is awaited so a start that CANNOT reach the service still records why --
      // but it does not throw, because this host runs processes whether or not aify-comms answers.
      await beat();
      // Deliberately not awaited: the claim loop runs for the life of the plugin.
      claimForever().catch((error) => host?.log?.(`aify-comms claim loop stopped: ${error?.message || error}`));
    },

    async stop() {
      stopped = true;
      if (heartbeatTimer) {
        clearTimeoutImpl(heartbeatTimer);
        heartbeatTimer = null;
      }
      // TELL THE SERVICE, best-effort. Without this the row stays fresh for its whole window and
      // `/spawn` accepts work for a claimer that has gone -- the queued-for-ever shape, arriving by
      // a different route.
      try {
        await api?.heartbeat({ ...(await advertisement()), status: "offline" });
      } catch {
        // A service we cannot reach on the way down ages the row out on its own. Failing here would
        // only stop the rest of the teardown.
      }
    },
  };
}
