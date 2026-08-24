// What a SERVICE said about its agents, turned into rows this environment can display.
//
// RELAY, NOT DERIVE. aify-env knows which processes it started and whether they are alive; alive is
// not working, and deciding an agent's status here would make this a second answer to a question
// aify-comms owns. So every field below is copied from the service's own response and attributed to
// it. Nothing here reads a process, a pid, or a liveness check -- and lib/tui.mjs asserts that a live
// process cannot change what an agent row says.
//
// That is the same shape as the service health rows already on the dashboard: this environment knocks,
// and renders what it was told.
//
// A service that cannot be reached yields NO rows and a stated reason. It must never fall back to
// "none running", which is a claim, and a wrong one whenever the service is simply down.

/** The statuses aify-comms uses for an agent that is doing something right now. */
const LIVE = new Set(["online", "working"]);

/**
 * Normalise one service's `/api/v1/agents` payload into display rows.
 *
 * The payload is a MAP of id -> record, not a list, which is the shape aify-comms returns. Anything
 * else yields no rows rather than a guess.
 *
 * @param {unknown} payload the parsed response body
 * @param {string} service the registry name of the service that answered
 * @returns {Array<{service: string, id: string, name: string, runtime: string, mode: string,
 *                  status: string}>}
 */
export function relayedAgents(payload, service) {
  const agents = payload && typeof payload === "object" ? payload.agents : null;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return [];
  const rows = [];
  for (const [id, record] of Object.entries(agents)) {
    if (!record || typeof record !== "object") continue;
    rows.push({
      service: String(service ?? ""),
      id: String(id),
      name: String(record.name ?? id),
      runtime: String(record.runtime ?? ""),
      mode: String(record.sessionMode ?? ""),
      // VERBATIM. An empty status stays empty rather than becoming "offline": not knowing and being
      // told "offline" are different answers and only one of them was given.
      status: String(record.status ?? ""),
    });
  }
  return rows;
}

/**
 * The ones the SERVICE considers live. Named for what it filters on, because "running" is exactly the
 * word that tempts a reader into thinking a process was checked.
 */
export function agentsTheServiceCallsLive(rows) {
  return (rows ?? []).filter((row) => LIVE.has(row.status));
}

/** Managed agents only -- the ones an environment could host. Residents never touch aify-env. */
export function managedOnly(rows) {
  return (rows ?? []).filter((row) => row.mode === "managed");
}

/**
 * A one-line summary of what was not shown, so a filtered view never reads as the whole population.
 * Returns "" when there is nothing left over, so a caller can skip the line entirely.
 */
export function remainderNote(all, shown) {
  const hidden = (all?.length ?? 0) - (shown?.length ?? 0);
  if (hidden <= 0) return "";
  const counts = new Map();
  const shownIds = new Set((shown ?? []).map((row) => `${row.service}/${row.id}`));
  for (const row of all ?? []) {
    if (shownIds.has(`${row.service}/${row.id}`)) continue;
    const key = row.status || "unstated";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort().map(([status, n]) => `${n} ${status}`);
  return `${hidden} not shown: ${parts.join(", ")}`;
}
