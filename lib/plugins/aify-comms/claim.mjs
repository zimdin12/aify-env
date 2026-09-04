// Claiming a spawn request for aify-comms, and what claiming commits this host to.
//
// WHY THIS IS THE WHOLE POINT OF THE PLUGIN. `/spawn` refuses unless an environment has a live
// BRIDGE -- `metadata.bridgeLastSeen` plus a live bridge row -- and only a heartbeat carrying a
// `bridgeId` stamps that field. aify-env already heartbeats the same endpoint to DESCRIBE the host
// and deliberately omits the id, so the row reads `online` while nothing can claim. Measured
// 2026-09-02: a row said `status: online, lastSeen 17:26:41Z` with `bridgeLastSeen` from the day
// before, and six spawns were refused on a host whose operator was running everything correctly.
//
// So the claim is TWO facts, not one: this host says "I am a claimer for aify-comms" (the stamped
// heartbeat), and then it asks for work. Sending the second without the first is what produced six
// 409s; accepting work without the first is what would queue a spawn for ever.
//
// EVERY DEPENDENCY IS INJECTED. This file makes no network call and reads no clock of its own, so
// the refusal paths -- the ones that only happen when something is already wrong -- can be tested
// rather than reasoned about. That is the half this project keeps finding broken in production.

/** The status a claimed request moves through. Named rather than typed inline so a typo is a
 *  reference error here instead of a request stuck in a state the service does not recognise. */
export const CLAIM_STARTING = "starting";
export const CLAIM_RUNNING = "running";
export const CLAIM_FAILED = "failed";

/**
 * Is this workspace inside what the environment advertised?
 *
 * THE RISKIEST STEP IN THE WHOLE PASS. A spawn request names a cwd, and this is what stops a
 * service launching a process anywhere on the host. It is answered against the roots THIS
 * environment declared, not against the request.
 *
 * PURE, and case-folded on Windows only: `C:/Users` and `c:/users` are one directory there and two
 * everywhere else, and folding unconditionally would let `/home/Bob` pass for a root of `/home/bob`
 * on a case-sensitive filesystem.
 */
export function workspaceWithinRoots(workspace, roots = [], { windows = false } = {}) {
  const normalise = (value) => {
    const text = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? text.toLowerCase() : text;
  };
  const target = normalise(workspace);
  if (!target) return false;
  return roots.some((root) => {
    const base = normalise(root);
    if (!base) return false;
    // The separator matters: without it a root of `/home/bo` would admit `/home/bob`.
    return target === base || target.startsWith(`${base}/`);
  });
}

/**
 * One claim pass: ask for a request, refuse it or start it, and report what happened either way.
 *
 * REPORTING IS NOT OPTIONAL ON ANY PATH. A claimed request the service never hears about again is
 * one it will hand to nobody else -- the agent waits for ever and the dashboard shows a spawn that
 * is neither running nor failed. Every early return below reports first.
 *
 * @returns {{outcome: string, spawnRequestId?: string, detail?: string}} what happened, for a caller
 *   that wants to log or count it. `idle` means there was nothing to claim, which is the usual case.
 */
export async function runClaimPass({
  api, environmentId, cwdRoots = [], windows = false, log = () => {},
  // Injected so a test can assert the pid that reaches the service. The daemon passes none.
  pid = process.pid,
}) {
  let claimed;
  try {
    claimed = await api.claim({ environmentId });
  } catch (error) {
    // A service that is down or refusing us is not an error this host can act on, and must not stop
    // the next pass from trying. It is reported, never thrown.
    return { outcome: "unreachable", detail: String(error?.message || error) };
  }
  const request = claimed?.spawnRequest;
  if (!request || !request.id) return { outcome: "idle" };

  /**
   * Report, and treat a refusal as an ANSWER rather than an exception.
   *
   * These were bare awaits until 2026-09-04 (external review, Round 8 H2). A throw from either --
   * `PATCH /spawn-requests/{id}` answers 409 when the operator cancels between the claim and the
   * report -- escaped this function, escaped `claimForever`, and landed in a one-shot `.catch`, so
   * this host stopped claiming until it was restarted. Invisibly: the heartbeat is a separate loop,
   * so `bridgeLastSeen` stayed fresh and every instrument read healthy while the queue never
   * drained.
   *
   * `api.claim` already had this shape and the reasoning is the same one, written above it: a
   * service that is down or refusing us is not an error this host can act on.
   */
  async function reportOrLog(spawnRequestId, patch) {
    try {
      await api.report(spawnRequestId, patch);
      return true;
    } catch (error) {
      log(`could not report spawn ${spawnRequestId} as ${patch.status}: ${error?.message || error}`);
      return false;
    }
  }

  const workspace = String(request.workspace || request.workspaceRoot || "").trim();
  if (!workspaceWithinRoots(workspace, cwdRoots, { windows })) {
    const detail = `Workspace "${workspace}" is outside this environment's advertised roots`;
    await reportOrLog(request.id, { status: CLAIM_FAILED, error: detail });
    log(`refused spawn ${request.id}: ${detail}`);
    return { outcome: "refused", spawnRequestId: request.id, detail };
  }

  // A REFUSED `starting` ENDS THIS PASS, and does not end the loop. The request is no longer ours to
  // act on -- a 409 means somebody cancelled it -- so carrying on to register a warm agent for it
  // would be acting on a claim the service has already taken back.
  if (!(await reportOrLog(request.id, { status: CLAIM_STARTING }))) {
    return { outcome: "report-refused", spawnRequestId: request.id };
  }

  // A CLAIM REGISTERS A WARM AGENT. IT DOES NOT START A PROCESS.
  //
  // This was the model this plugin got wrong, and the first real spawn found it: six requests were
  // claimed within seconds and all six failed with "a start request must name a launcher to run",
  // because this built a start spec from `request.launcher` -- a field the wire has never carried.
  //
  // MEASURED against the code this replaced. `mcp/stdio/spawn-loop.mjs`, the bridge's claim
  // consumer, contains ZERO process starts: it reports `running` carrying its OWN pid, and the
  // worker is started LATER by the terminal control path when the service asks for it. That is what
  // `mode: "managed-warm"` means, and every spawn this system issues uses it. Starting here would
  // launch a process at claim time that nothing has work for yet.
  //
  // REPORTING `running` IS WHAT CREATES THE AGENT. The service's own words for that transition are
  // "convert a spawn request into a live agent" -- it writes the agents and sessions rows from the
  // spawn spec, and derives the runtime's capabilities itself. So this sends the facts only THIS
  // host knows and invents nothing: which environment claimed it, under which request, and the pid
  // of the process that will own the work.
  const runtimeState = {
    environmentId,
    spawnRequestId: request.id,
    mode: request.mode || "managed-warm",
    resumePolicy: request.resumePolicy || "native_first",
  };
  const sessionHandle = String(request.sessionHandle || "").trim();
  try {
    await api.report(request.id, {
      status: CLAIM_RUNNING,
      // THIS DAEMON'S pid, as the bridge reported its own. It is the process that will hold the
      // worker, not the worker itself -- which does not exist yet, and saying otherwise would put a
      // pid in the row that nothing is running.
      processId: String(pid),
      sessionHandle,
      runtimeState,
    });
  } catch (error) {
    // A claimed request the service never hears about again is one it hands to nobody else: the
    // agent waits for ever and the dashboard shows a spawn that is neither running nor failed.
    const detail = String(error?.message || error);
    log(`spawn ${request.id} was claimed but could not be reported: ${detail}`);
    return { outcome: "failed", spawnRequestId: request.id, detail };
  }
  log(`registered managed agent "${request.agentId || request.id}" from request ${request.id}`);
  return { outcome: "registered", spawnRequestId: request.id };
}
