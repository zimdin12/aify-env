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
import { readFileSync } from "node:fs";

import { runClaimPass, workspaceWithinRoots } from "./claim.mjs";
import { createHandleBook, runTerminalControlPass } from "./terminal-controls.mjs";
import { buildStartSpec } from "../../start-spec.mjs";
import { launcherCandidates } from "../../launcher-resolve.mjs";

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
 * The id aify-comms files this host under.
 *
 * THE SHAPE IS THE SERVICE'S, so it lives here rather than in the host. `advertise.mjs` sends a RAW
 * hostname and the service joins it into `${kind}:${hostname}:default`; the live rows were written
 * from a raw `os.hostname()`, so normalising here would mint a new id for every existing environment
 * and orphan the agents bound to the old one.
 */
export function environmentIdFor({ kind = "", hostname = "" } = {}) {
  return `${String(kind || "")}:${String(hostname || "")}:default`;
}

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
  // WHICH OS, separately from `windows`, because two consumers ask two different questions of it:
  // the roots guard asks whether paths fold case, and the launcher resolver asks whether a `.cmd`
  // shim sits beside the file it must actually run. Deriving one from the other reads fine and
  // couples a path-comparison rule to a process-spawning rule.
  platform = process.platform,
  api: injectedApi = null,
  // Injected so a test drives the whole loop without a launcher on disk; the daemon
  // passes none and the pass reads the real filesystem.
  readFile = undefined,

  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let api = injectedApi;
  let heartbeatTimer = null;
  let claiming = false;
  let controlling = false;
  //: WHAT THIS HOST STARTED, by the name the SERVICE uses for it. Two tiers name one thing
  //: differently and only the runner's name works on the runner; this host is the only thing
  //: that knows both, because it is the one that started the process.
  const handles = createHandleBook();
  let stopped = true;
  let host = null;
  //: What the last pass did, so a doctor or a TUI can say why nothing is being claimed rather than
  //: leaving an operator to infer it from silence. That inference cost a day.
  const state = {
    lastHeartbeat: "", lastHeartbeatError: "", lastClaim: "", claimedTotal: 0,
    //: THE SECOND LOOP'S OWN COUNTERS. Folding these into the claim's would make a host that claims
    //: but cannot RUN anything indistinguishable from a healthy one -- which is exactly the state
    //: six spawns were in on 2026-09-03, claimed and never started.
    lastControl: "", controlsHandled: 0,
    //: WHETHER THIS HOST IS THE RECOGNISED CLAIMER, as the service last answered it.
    //: `null` means either nothing has beaten yet or the service is old enough not to
    //: say -- both are "unknown", and neither may read as yes.
    claimer: null,
  };

  async function beat() {
    if (stopped) return;
    try {
      const answer = await api.heartbeat(await advertisement());
      state.lastHeartbeat = new Date().toISOString();
      state.lastHeartbeatError = "";
      // ACCEPTED IS NOT THE SAME AS DELIVERED, and believing it was cost a day on 2026-09-02. The
      // service arbitrates supersession and may DISCARD a beat while answering `ok: true` -- so a
      // 200 says the request was well-formed, never that this host is the claimer. Without this
      // read, a plugin beats every 30s, `bridgeLastSeen` never moves, `/spawn` refuses every
      // request, and both sides report healthy. That is exactly what happened.
      //
      // `claimer` ABSENT means an older service that cannot answer the question; that is not a
      // refusal and must not be reported as one, or every host on a service one version back would
      // log a fault it does not have.
      const claimer = answer && typeof answer === "object" ? answer.claimer : null;
      // `claimer.bridgeId` IS THE HOLDER'S, not ours -- on a refusal it names whoever owns the row.
      // That is the useful value and it is also easy to misread as our own: it cost ten minutes of
      // wrong reasoning on 2026-09-03, staring at a `/health` that showed an id matching the row and
      // concluding arbitration was refusing us over ourselves. So both travel, named.
      state.claimer = claimer
        ? {
          ...claimer,
          holderBridgeId: claimer.bridgeId || "",
          // OPTIONAL, because reporting must never be able to break the beat. An api without an
          // identity accessor is a test double or an older client; reading through it threw inside
          // `beat`, was caught, and turned an accepted heartbeat into a reported failure -- a
          // diagnostic field that breaks the thing it describes.
          ourBridgeId: api?.identity?.bridgeId || "",
        }
        : null;
      if (claimer && claimer.accepted === false) {
        state.lastHeartbeatError = `not the claimer: ${claimer.reason || "refused"}`;
        host?.log?.(
          `aify-comms accepted the heartbeat but did NOT accept this host as the claimer`
          + ` (holder: ${claimer.bridgeId || "unknown"}; ${claimer.reason || "no reason given"}).`
          + ` Spawns here will be refused until that is resolved.`,
        );
      }
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
        // THE LOOP SURVIVES A THROWING PASS, since 2026-09-04 (external review, Round 8 H2).
        //
        // This was `try { while ... } finally {}` with no catch, and the caller is a one-shot
        // `.catch(log)` -- so ONE throw anywhere in a pass ended claiming for the life of the
        // process. Silently: the heartbeat is a separate loop, so `bridgeLastSeen` kept refreshing,
        // the doctor's `claimer.accepted` kept passing, `/spawn` kept accepting, and the queue
        // simply never drained.
        //
        // The known throw is fixed at its source in `claim.mjs`. This is the CLASS: a pass that
        // fails for a reason nobody anticipated must cost one interval, never the loop. The state is
        // recorded so `lastClaim` shows the failure instead of freezing on its last good value --
        // an instrument that stops moving is worse than one that reports trouble.
        let result;
        try {
          result = await runClaimPass({
            api,
            // DERIVED FROM WHAT THIS HOST ADVERTISES, not handed down by it: the id's shape is
            // aify-comms' convention and the host does not know it.
            environmentId: environmentIdFor(await advertisement()),
            cwdRoots: await cwdRoots(),
            windows,
            log: (message) => host?.log?.(message),
          });
        } catch (error) {
          host?.log?.(`aify-comms claim pass failed: ${error?.message || error}`);
          result = { outcome: "unreachable" };
        }
        state.lastClaim = result.outcome;
        // `registered`, not `started`: a claim makes the agent WARM and starts nothing. Counting
        // `started` here after the pass stopped emitting it would have left this at 0 for ever --
        // a metric that silently stops moving is worse than one that was never added.
        if (result.outcome === "registered") state.claimedTotal += 1;
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

  /**
   * The SECOND loop, and it is what makes this host the process host.
   *
   * TWO LOOPS, NOT ONE, because they answer different questions and neither may delay the other. A
   * spawn claim asks "is there an agent to register here"; a terminal control asks "is there a
   * process to run". The aify-comms bridge kept them separate for the same reason, and merging them
   * would let a quiet spawn queue hold up an operator pressing Stop.
   */
  async function controlForever() {
    if (controlling) return;
    controlling = true;
    try {
      while (!stopped) {
        const result = await runTerminalControlPass({
          api,
          processes: host.processes,
          environmentId: environmentIdFor(await advertisement()),
          cwdRoots: await cwdRoots(),
          windows,
          withinRoots: workspaceWithinRoots,
          // THE SAME SPEC BUILDER THE HTTP ENDPOINT USES, so the allowlist judges a plugin-started
          // process exactly as it judges one an operator asked for over HTTP. A second path with its
          // own idea of what may execute is the shape this seam exists to prevent.
          buildSpec: (spec) => buildStartSpec(spec, {
            // The REAL reader unless a test injected one. `buildStartSpec` reads the launcher
            // to judge it, so handing it `undefined` would refuse every start with a message
            // about the reader rather than about the launcher.
            readFile: readFile || ((path) => readFileSync(path, "utf8")),
            platform,
          }),
          resolveCandidates: (command) => launcherCandidates(command, { platform }),
          handles,
          log: (message) => host?.log?.(message),
        });
        state.lastControl = result.outcome;
        if (result.handled) state.controlsHandled += result.handled;
        const pause = result.outcome === "unreachable" ? RETRY_AFTER_ERROR_MS : MIN_PASS_INTERVAL_MS;
        await new Promise((resolve) => setTimeoutImpl(resolve, pause));
      }
    } finally {
      controlling = false;
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
      // Deliberately not awaited: both loops run for the life of the plugin.
      claimForever().catch((error) => host?.log?.(`aify-comms claim loop stopped: ${error?.message || error}`));
      // AND THE ONE THAT ACTUALLY RUNS THINGS. Started separately and reported separately: a host
      // whose claim loop is healthy and whose control loop has died claims agents it can never run,
      // which reads as working from every angle except the one that matters.
      controlForever().catch((error) => host?.log?.(`aify-comms terminal control loop stopped: ${error?.message || error}`));
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
