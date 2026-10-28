// The `managed-orphans` check: managed delivery loops running for agents that belong to no live bridge.
//
// MOVED HERE FROM `aify-comms doctor` in 0.9.7 (plan D11). The loop is aify-comms' process
// (`hermes-managed-host.js run <agent>`) and the binding it is judged against is aify-comms' record, so
// it lives in aify-comms' plugin; the process table comes from the core (`lib/process-list.mjs`).
//
// THE FIELD CASE, 2026-08-26. Six loops were alive on the operator's host, the oldest at 96 minutes,
// each holding a hermes gateway, while every one of their agents read `available` on the dashboard.
//
// READ-ONLY: it enumerates and names, and never kills. Deciding to kill needs ownership this check does
// not have, and the launcher already reaps an agent's prior loop at the one moment it is safe.

/** How fresh a claimer's stamp must be to claim a spawn: the service's own window. */
const SPAWN_CLAIMER_FRESH_SECONDS = 90;
/** How far ahead of this clock a stamp may be before it reads as invalid rather than fresh. */
const BRIDGE_STAMP_SKEW_SECONDS = 120;

/**
 * Whether a bridge has spoken for this environment recently enough to claim a spawn.
 *
 * THE SERVICE'S ANSWER FIRST: `/environments` carries `spawnClaim.state`, computed by the rule `/spawn`
 * refuses on, against the service's clock. The local computation is the fallback for a service too old
 * to send it. Only `fresh` is live; `stale`, `absent` and `invalid` are not.
 */
export function envCanClaimASpawnAt(env, now) {
  const answered = String(env?.spawnClaim?.state || "").trim();
  if (["fresh", "stale", "absent", "invalid"].includes(answered)) return answered === "fresh";
  const stamp = String(env?.metadata?.bridgeLastSeen || "").trim();
  if (!stamp) return false;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return false;
  const age = now - at;
  if (age < -BRIDGE_STAMP_SKEW_SECONDS * 1000) return false;
  return age <= SPAWN_CLAIMER_FRESH_SECONDS * 1000;
}

/**
 * The agent a delivery loop serves, or null when this command line is not one.
 *
 * Requires the host script AND the `run <agent>` subcommand: `ensure-host` and bare invocations are not
 * long-lived loops. The id charset mirrors the service's `SAFE_NAME_RE`, dot included (`team.coder`).
 */
export function cmdlineDeliveryLoopAgent(commandLine) {
  const match = String(commandLine || "").match(/hermes-managed-host\.js\s+run\s+([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return match ? match[1] : null;
}

/**
 * Managed delivery loops running for agents that no longer belong to any live bridge.
 *
 * WHY THIS IS A CHECK AND NOT A REAPER. An orphaned loop is a `hermes-managed-host.js run <agent>`
 * process, launched detached under nohup so it deliberately OUTLIVES whatever started it. Nothing
 * collects one during normal operation: the survivor sweep runs at bridge BOOT, so a loop orphaned
 * mid-session accumulates until the next relaunch. Six were alive on the operator's host on
 * 2026-08-26, the oldest at 96 minutes, each holding a hermes gateway.
 *
 * They are also INVISIBLE from the control plane, which is the reason this belongs in doctor rather
 * than the dashboard: the agent reads `available` because it has no live channel sidecar, and its
 * `lastSeen` keeps refreshing because the orphan itself is heartbeating. The liveness signal that
 * would prove it dead is the one the orphan keeps emitting. An operator reading the dashboard sees
 * "not running" beside a process that is running -- the operator asked exactly this on 2026-08-26,
 * having watched agents "seem to be running still" after the panel reported them dead.
 *
 * IT REPORTS AND NEVER KILLS. Deciding to kill needs ownership this predicate does not have, and the
 * repo already has one env-scoped reaper that does it correctly at the only moment it is safe.
 *
 * PURE.
 *
 * @param {object}   input
 * @param {Array|null} input.loops  [{agentId, pid}] enumerated loops, or null if unreadable.
 * @param {object|null} input.agents  {agentId: {sessionMode, runtimeState}}, or null if unreachable.
 * @param {string[]|null} input.liveBridgeIds  Every bridge beating now: the online environment's and each one
 *   `/bridges` lists. A hermes the operator starts by hand runs this same loop bound to its own resident
 *   bridge, so the environment's alone accused every one of them (pc-manager, 2026-10-13). Null if unknown.
 */
export function managedOrphanVerdict({ loops = null, agents = null, liveBridgeIds = null } = {}) {
  // NO EVIDENCE IS NOT A PASS. Each of the three inputs can be absent for its own reason -- an
  // unreadable process table, a service that is down, no bridge online -- and every one of them makes
  // the answer unknown rather than clean. `env-bridge` and `bridge-current` both shipped as
  // green-by-default and both were wrong the same way (`a2f9e42`, `756f3a5`).
  const missing = [];
  if (loops === null) missing.push("the process table could not be read");
  if (agents === null) missing.push("the service did not answer");
  if (!Array.isArray(liveBridgeIds) || liveBridgeIds.length === 0) missing.push("no bridge is online");
  if (missing.length) {
    return {
      ok: false,
      code: "unknown-all",
      detail: `Orphaned managed workers could not be counted: ${missing.join("; ")}. Nothing was `
        + "verified, so this is not a clean result.",
      fix: "Fix the named condition, then re-run. The `aify-comms` row above says whether the service "
        + "answered, and `aify-comms doctor` reports its bridges.",
    };
  }

  // ONE LOGICAL LOOP PER AGENT. Enumeration matches on the command line, and the launcher is
  // `nohup node hermes-managed-host.js run <agent>` -- so the nohup parent AND its node child both
  // match, and counting pids would report every loop twice.
  const byAgent = new Map();
  for (const loop of loops) {
    const agentId = String(loop?.agentId || "").trim();
    if (!agentId) continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId).push(loop.pid);
  }
  if (byAgent.size === 0) {
    return { ok: true, code: "none", detail: "No managed delivery loops are running on this host.", fix: "" };
  }

  const orphans = [];
  for (const [agentId, pids] of byAgent) {
    const row = agents[agentId];
    // A loop for an agent the service does not know is orphaned by definition: nothing can address it.
    const boundTo = String(row?.runtimeState?.bridgeInstanceId || "").trim();
    if (boundTo && liveBridgeIds.includes(boundTo)) continue;
    orphans.push({ agentId, pids: pids.slice().sort((a, b) => a - b), boundTo: boundTo || "(none)" });
  }
  if (orphans.length === 0) {
    return {
      ok: true,
      code: "ok",
      detail: `${byAgent.size} managed delivery loop(s) running, all bound to a live bridge.`,
      fix: "",
    };
  }
  const named = orphans
    .map((o) => `${o.agentId} (pid ${o.pids.join("+")}, bound to ${o.boundTo})`)
    .join(", ");
  return {
    ok: false,
    code: "orphaned",
    detail: `${orphans.length} of ${byAgent.size} managed delivery loop(s) belong to no live bridge, `
      + `so they hold a gateway and a session that nothing can address: ${named}. Their agents read `
      + "`available` on the dashboard while these processes are running.",
    fix: "Restart each named agent -- its launcher reaps that agent's prior loop as it spawns. A loop "
      + "whose agent is gone has no launcher coming: stop it by the pid named here.",
  };
}

/**
 * Gather the evidence and add the row.
 *
 * @param deps.reads          aify-comms reads (`serviceReads`), each answering null when the service does not
 * @param deps.add            record a check result
 * @param deps.listProcesses  every process on this host; throws when the table cannot be read
 * @param deps.selfPid        this process's pid, which a real listing must contain
 * @param deps.now            epoch ms, for the claimer-freshness fallback
 */
export async function checkManagedOrphans({ reads, add, listProcesses, selfPid = process.pid, now = Date.now }) {
  const agentsBody = await reads.agents();
  const agents = agentsBody && agentsBody.agents && typeof agentsBody.agents === "object"
    ? agentsBody.agents
    : null;

  const envs = await reads.environments();
  // The BRIDGE's liveness, not the row's advertised status: a loop belongs to no live bridge whenever
  // no bridge can claim a spawn, and reading `status` here would attribute orphans to a bridge that
  // has not spoken since yesterday.
  const at = now();
  const online = (envs && envs.environments ? envs.environments : []).filter((env) => envCanClaimASpawnAt(env, at));
  const live = await reads.bridges();
  const liveBridgeIds = envs && live
    ? [...online.map((env) => String(env.bridgeId || "")), ...(live.bridges || []).map((b) => String(b?.id || ""))]
      .filter(Boolean)
    : null;

  // THE HOST IS LISTED ONLY WHEN THERE IS SOMETHING TO COMPARE IT AGAINST. With no agents or no live
  // bridge the verdict is `unknown-all` whatever the table holds, and the listing is a whole-host
  // PowerShell CIM query: measured 2026-10-14, it took a doctor run against a silent service from about
  // 0.2 s to 0.8 s, and the suite spawns that doctor repeatedly beside daemon tests that are
  // sensitive to load. Not listed, the table is not claimed unreadable: `loops` is null only when a
  // listing was tried and failed, so the detail names only the inputs that were really missing.
  let loops = [];
  if (agents !== null && Array.isArray(liveBridgeIds) && liveBridgeIds.length > 0) {
    try {
      const rows = listProcesses();
      // AN EMPTY TABLE IS NOT AN EMPTY ANSWER. This process is running, so a table that does not
      // contain it did not read the host.
      if (!rows.some((row) => row && row.pid === selfPid)) throw new Error("enumeration did not include this process");
      loops = rows
        .map((row) => ({ agentId: cmdlineDeliveryLoopAgent(row.commandLine), pid: row.pid }))
        .filter((row) => row.agentId);
    } catch {
      loops = null;
    }
  }

  const verdict = managedOrphanVerdict({ loops, agents, liveBridgeIds });
  return add("managed-orphans", verdict.ok, verdict.code, verdict.detail, verdict.fix);
}
