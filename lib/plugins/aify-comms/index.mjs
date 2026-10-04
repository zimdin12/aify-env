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

import { importRecords } from "./agent-import-records.mjs";
import { AgentStarter } from "./agent-starter.mjs";
import { claimerFromAnswer } from "./claimer-answer.mjs";
import { runClaimPass, workspaceWithinRoots } from "./claim.mjs";
import { runPasses } from "./pass-loop.mjs";
import { DETACHING, PluginPhase } from "./plugin-phase.mjs";

// STILL EXPORTED HERE, where it was before the split, so an existing importer of this module keeps
// working; plugin-phase.mjs is its only definition (review of d2ce11f, S1).
export { DETACHING };
import { createHandleBook, heldTerminalIds, runTerminalControlPass } from "./terminal-controls.mjs";
import { createOutputSender } from "./output-sender.mjs";
import { DefinitionSync, REQUEST_POLL_MS } from "./definition-sync.mjs";
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
  // The registry entry this plugin was built from: the host resolves its key from this, not from
  // whatever the registry names now (P0 C8).
  service = null,
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
  // This host's proof for this service, from the plugin registry (lib/plugins/index.mjs).
  hostProof = null,
  // THIS HOST'S AGENT DEFINITIONS (P0 C3, C4, C7): the store the plugin publishes, applies requests
  // to and checks starts against, and the harnesses this host can launch. No store, no definitions.
  definitions = null,
  installedHarnesses = async () => new Set(),
  // Injected so a test drives the whole loop without a launcher on disk; the daemon
  // passes none and the pass reads the real filesystem.
  readFile = undefined,

  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let api = injectedApi;
  /** Ordered, coalescing terminal output for every terminal this host runs. See Round 8 M3. */
  let outputSender = null;
  let heartbeatTimer = null;
  let claiming = false;
  let controlling = false;
  let syncing = false;
  let definitionSync = null;
  //: WHAT THIS HOST STARTED, by the name the SERVICE uses for it. Two tiers name one thing
  //: differently and only the runner's name works on the runner; this host is the only thing
  //: that knows both, because it is the one that started the process.
  const handles = createHandleBook();
  let stopped = true;
  let host = null;
  //: THE CONFIGURATION PHASE (P0 C8), separate from `stopped`, which is the HOST going away.
  const phase = new PluginPhase();
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
      // WHICH TERMINALS THIS HOST STILL HOLDS, from the same predicate as the liveness frames. The
      // service ends this environment's other confirmed terminals on it, which is how a restart
      // ends a predecessor's rows on the first beat instead of through the ghost reaper.
      const answer = await api.heartbeat(await advertisement(), {
        heldTerminals: heldTerminalIds(handles, host?.processes),
      });
      // A REPLY THAT ARRIVES AFTER A DETACH describes a plugin that no longer exists here.
      if (phase.detached) return;
      state.lastHeartbeat = new Date().toISOString();
      const read = claimerFromAnswer(answer, {
        wasRefused: state.claimRefused === true,
        // OPTIONAL, because reporting must never be able to break the beat. An api without an
        // identity accessor is a test double or an older client; reading through it threw inside
        // `beat`, was caught, and turned an accepted heartbeat into a reported failure -- a
        // diagnostic field that breaks the thing it describes.
        ourBridgeId: api?.identity?.bridgeId || "",
      });
      state.claimer = read.claimer;
      // It was logged and otherwise ignored, so a refused host kept asking to claim four times a
      // second for ever -- `runClaimPass` reads only `spawnRequest`, so a refusal reads as `idle`,
      // and `idle` takes the SHORT floor. The claim loop's back-off reads this.
      state.claimRefused = read.claimRefused;
      state.lastHeartbeatError = read.lastHeartbeatError;
      if (read.logLine) host?.log?.(read.logLine);
    } catch (error) {
      // A late FAILURE describes the detached plugin too, so it is dropped the same way.
      if (phase.detached) return;
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
      await runPasses({
        label: "claim",
        // Only while running: a plugin being detached claims no new spawn, and neither does one held
        // for its workers, since a claimed spawn is a start it would then have to refuse.
        runs: () => !stopped && phase.claims,
        // THE WHOLE PASS IS TRACKED, its setup awaits included, and the phase is read again after
        // them: a detach that lands during the setup must either wait for this pass or stop it.
        pass: () => phase.track("claim", (async () => {
          // DERIVED FROM WHAT THIS HOST ADVERTISES, not handed down by it: the id's shape is
          // aify-comms' convention and the host does not know it.
          const environmentId = environmentIdFor(await advertisement());
          const roots = await cwdRoots();
          if (!phase.claims) return { outcome: "detaching" };
          return runClaimPass({
            api,
            environmentId,
            // WHICH MACHINE CLAIMED IT. The service stores this on the agent row, and the start
            // menu beside this loop offers only agents whose machine is this one.
            machineId,
            cwdRoots: roots,
            windows,
            log: (message) => host?.log?.(message),
          });
        })()),
        settle: (result) => {
          state.lastClaim = result.outcome;
          // `registered`, not `started`: a claim makes the agent WARM and starts nothing. Counting
          // `started` here after the pass stopped emitting it would have left this at 0 for ever --
          // a metric that silently stops moving is worse than one that was never added.
          if (result.outcome === "registered") state.claimedTotal += 1;
          // A LONG back-off when something is wrong; a SHORT floor otherwise. The floor is not
          // latency an operator will notice -- a spawn already crossed a network -- and it is the
          // only thing standing between a service that stops long-polling and a pinned core.
          //
          // A REFUSED CLAIMER TAKES THE LONG ONE TOO. The service has told us, on the heartbeat, that
          // another host owns this environment; asking anyway four times a second is a `BEGIN
          // IMMEDIATE` on its database eight times as often as the beat that keeps saying no. It is a
          // BACK-OFF and not a stop: the flag clears itself on the beat that accepts us, and this
          // resumes with no restart and no operator step.
          return (result.outcome === "unreachable" || state.claimRefused === true)
            ? RETRY_AFTER_ERROR_MS
            : MIN_PASS_INTERVAL_MS;
        },
        log: (message) => host?.log?.(message),
        setTimeoutImpl,
      });
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
      await runPasses({
        label: "terminal control",
        runs: () => !stopped && phase.controls,
        // Tracked whole and the phase read again after the setup awaits, as in the claim loop.
        pass: () => phase.track("control", (async () => {
          const environmentId = environmentIdFor(await advertisement());
          const roots = await cwdRoots();
          if (!phase.controls) return { outcome: "detaching" };
          return runTerminalControlPass({
            api,
            processes: host.processes,
            // ONE SENDER FOR THE LIFE OF THIS PLUGIN, not one per pass. Output ordering is a
            // per-terminal property that has to hold ACROSS passes -- a sender created per pass
            // would order within one and interleave between them, which is the bug this fixes
            // wearing a hat (Round 8 M3).
            sender: outputSender,
            environmentId,
            cwdRoots: roots,
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
            refuseStarts: () => phase.refusal(),
            // C7 AT THE PROCESS-START BOUNDARY: a start built from a definition runs only while this
            // host's file is that definition.
            admitStart: definitions ? (launch, produce) => definitions.admitStart(launch, produce) : null,
            // WHAT OTHER PLUGINS ADD to a defined worker's env, asked about the definition this host's file holds
            // for the revision the start was built from (spawn-env.mjs).
            spawnEnv: () => host?.spawnEnv?.() ?? [],
            definitionFor: definitions ? (launch) => definitions.boundReading(launch) : null,
          });
        })()),
        settle: (result) => {
          state.lastControl = result.outcome;
          if (result.handled) state.controlsHandled += result.handled;
          return result.outcome === "unreachable" ? RETRY_AFTER_ERROR_MS : MIN_PASS_INTERVAL_MS;
        },
        log: (message) => host?.log?.(message),
        setTimeoutImpl,
      });
    } finally {
      controlling = false;
    }
  }

  /** The THIRD loop: this host's definitions published and the operator's changes to them applied. It
   *  runs while the plugin claims, since a detached or held plugin speaks for this host no longer. */
  async function syncForever() {
    if (syncing || !definitionSync) return;
    syncing = true;
    try {
      await runPasses({
        label: "definition sync",
        runs: () => !stopped && phase.claims,
        pass: () => phase.track("sync", (async () => {
          const environmentId = environmentIdFor(await advertisement());
          if (!phase.claims) return { outcome: "detaching" };
          return definitionSync.pass(environmentId);
        })()),
        settle: () => REQUEST_POLL_MS,
        log: (message) => host?.log?.(message),
        setTimeoutImpl,
      });
    } finally {
      syncing = false;
    }
  }

  //: The operator-facing capability this plugin offers the host, built in `start()` because it
  //: needs the api. Null until then, which the delegator below reports rather than throwing.
  let starter = null;

  //: Every capability answers the same way when the plugin has not started: a refusal that says so.
  //: A route reaching a plugin that failed to boot would otherwise report a connection error, which
  //: sends the operator to look at aify-comms when the thing that is wrong is here.
  const notStarted = "the aify-comms plugin is not running on this host";

  return {
    name: "aify-comms",
    //: Which endpoint this plugin serves, so a registry change can tell it is no longer the one named.
    endpoint: String(endpoint || ""),

    /**
     * WHAT THIS PLUGIN OFFERS THE HOST, as opposed to what the host does TO it.
     *
     * Under its own key because `start` and `stop` here would be the lifecycle methods beside them.
     * The host reaches this through `ServicePlugins.capability("agents")` and never names the
     * plugin -- so a second `aify-` service offering the same capability needs no change up there.
     */
    capabilities: {
      agents: {
        //: WHO IS BEING ASKED, carried with the answer. The view wants to say "asking aify-comms…"
        //: while it waits, and the HOST must not know that name -- `docs/AIFY_ENV_BOUNDARY.md` puts
        //: service knowledge on this side of the line and nowhere else. A hardcoded name in the
        //: renderer would be wrong the day a second `aify-` service offers the same capability, and
        //: wrong in the most confusing way: naming the service that is NOT answering.
        service: "aify-comms",
        list: async () => (starter ? starter.list() : { agents: [], problem: notStarted }),
        start: async (agentId) => (starter && !phase.refusal()
          ? starter.start(agentId)
          : { started: false, agentId: String(agentId || ""), sessionId: "", problem: starter ? DETACHING : notStarted }),
        setHerdrSpace: async (agentId, show) => (starter
          ? starter.setHerdrSpace(agentId, show)
          : { ok: false, problem: notStarted }),
        //: THIS MACHINE'S AGENTS READ AS DEFINITIONS, for `aify-env agents import` (P0 C10). Reads only.
        importable: async () => (starter
          ? { agents: importRecords(await api.agents(), machineId), problem: "" }
          : { agents: [], problem: notStarted }),
      },
    },

    /** For a doctor, a TUI, or a test: what this plugin is actually doing. */
    state: () => ({ ...state, phase: phase.name, heldWorkers: heldTerminalIds(handles, host?.processes).length,
      definitions: definitionSync ? { ...definitionSync.state } : null }),

    async start(pluginHost) {
      host = pluginHost;
      stopped = false;
      phase.begin();
      if (!api) {
        api = new CommsApi({
          endpoint,
          credential: () => host.credential(service),
          hostProof,
          identity: mintBridgeIdentity({ version }),
        });
      }
      // The first beat is awaited so a start that CANNOT reach the service still records why --
      // but it does not throw, because this host runs processes whether or not aify-comms answers.
      // Built here rather than at module scope: it needs `api`, which is only settled above.
      // BUILT HERE, for the same reason `outputSender` is: it needs `api`, which is only settled
      // above. Scoped to this host's machine id, so the list it produces is agents an operator at
      // this screen could actually watch come up.
      starter = new AgentStarter({ api, machineId, definitions });
      definitionSync = definitions
        ? new DefinitionSync({ api, store: definitions, installed: installedHarnesses, machineId, log: (message) => host?.log?.(message) })
        : null;
      outputSender = createOutputSender({
        post: (id, body) => api.terminalOutput(id, body),
        log: (message) => host?.log?.(message),
        status: "attached",
      });
      await beat();
      // Deliberately not awaited: both loops run for the life of the plugin.
      claimForever().catch((error) => host?.log?.(`aify-comms claim loop stopped: ${error?.message || error}`));
      // AND THE ONE THAT ACTUALLY RUNS THINGS. Started separately and reported separately: a host
      // whose claim loop is healthy and whose control loop has died claims agents it can never run,
      // which reads as working from every angle except the one that matters.
      controlForever().catch((error) => host?.log?.(`aify-comms terminal control loop stopped: ${error?.message || error}`));
      syncForever().catch((error) => host?.log?.(`aify-comms definition sync stopped: ${error?.message || error}`));
    },

    /**
     * A CONFIGURATION DETACH, not a host shutdown (P0 C8): the registry no longer names this service
     * at this endpoint. Quiesce, wait for the in-flight long-polls and handle what they returned under
     * the quiescing rule, then decide on what this host holds. Holding nothing, it detaches with no
     * offline beat. Holding workers, it is KEPT: it serves them, refuses starts, and says so; the
     * caller asks again, and it detaches once the last one has ended.
     *
     * @returns {Promise<{detached: boolean, held: number}>}
     */
    async detach() {
      if (stopped || phase.detached) return { detached: true, held: 0 };
      const wasHeld = await phase.quiesce();
      const held = heldTerminalIds(handles, host?.processes).length;
      if (held > 0) {
        // SAID ONCE, on becoming held; the state says it after that.
        if (!wasHeld) {
          host?.log?.(`aify-comms: registry change pending: ${held} worker${held === 1 ? "" : "s"} still held;`
            + " starts are refused and it detaches when the last one ends.");
        }
        phase.hold();
        controlForever().catch((error) => host?.log?.(`aify-comms terminal control loop stopped: ${error?.message || error}`));
        return { detached: false, held };
      }
      phase.detach();
      stopped = true;
      if (heartbeatTimer) {
        clearTimeoutImpl(heartbeatTimer);
        heartbeatTimer = null;
      }
      await handles.exitMarkersSettled();
      return { detached: true, held: 0 };
    },

    /**
     * The registry names this plugin's service at its endpoint again while it is held: the change was
     * undone, so it claims and starts again. Only a held plugin resumes; anything else answers false.
     */
    resume() {
      if (stopped || !phase.resume()) return false;
      claimForever().catch((error) => host?.log?.(`aify-comms claim loop stopped: ${error?.message || error}`));
      syncForever().catch((error) => host?.log?.(`aify-comms definition sync stopped: ${error?.message || error}`));
      return true;
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
      //
      // HOLDING NOTHING, because this host is going and takes its processes with it: the service
      // ends this environment's terminals on this beat. Exit markers already on their way are
      // waited for alongside it -- they carry how a worker ended, and the daemon exits right after.
      // The shutdown bounds how long all of this may take.
      const offline = (async () => {
        try {
          await api?.heartbeat({ ...(await advertisement()), status: "offline" }, { heldTerminals: [] });
        } catch {
          // A service we cannot reach on the way down ages the row out on its own. Failing here would
          // only stop the rest of the teardown.
        }
      })();
      await Promise.all([offline, handles.exitMarkersSettled()]);
    },
  };
}
