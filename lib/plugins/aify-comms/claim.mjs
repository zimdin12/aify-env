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
export async function runClaimPass({ api, processes, environmentId, cwdRoots = [], windows = false, log = () => {} }) {
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

  const workspace = String(request.workspace || request.workspaceRoot || "").trim();
  if (!workspaceWithinRoots(workspace, cwdRoots, { windows })) {
    const detail = `Workspace "${workspace}" is outside this environment's advertised roots`;
    await api.report(request.id, { status: CLAIM_FAILED, error: detail });
    log(`refused spawn ${request.id}: ${detail}`);
    return { outcome: "refused", spawnRequestId: request.id, detail };
  }

  await api.report(request.id, { status: CLAIM_STARTING });

  let started;
  try {
    started = await processes.start({
      launcher: request.launcher || "",
      args: Array.isArray(request.args) ? request.args : [],
      cwd: workspace,
      env: request.env && typeof request.env === "object" ? request.env : {},
      label: request.agentId || request.id,
      service: "aify-comms",
    });
  } catch (error) {
    // THE HOST'S OWN REASON, passed through rather than reworded. "The agent did not start" is what
    // this used to look like from the dashboard, minutes later, with the cause discarded here.
    const detail = String(error?.message || error);
    await api.report(request.id, { status: CLAIM_FAILED, error: detail });
    log(`spawn ${request.id} failed to start: ${detail}`);
    return { outcome: "failed", spawnRequestId: request.id, detail };
  }

  await api.report(request.id, {
    status: CLAIM_RUNNING,
    processId: String(started?.pid ?? ""),
    // The HOST's id for the process, so a later stop or write can find it. Without this the service
    // knows a spawn is running and has no handle to reach it.
    handle: String(started?.id ?? ""),
  });
  log(`spawned "${request.agentId || request.id}" as process ${started?.id}`);
  return { outcome: "started", spawnRequestId: request.id };
}
