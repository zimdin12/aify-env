// The checks ported from aify-comms read the service through named reads (`serviceReads` in
// lib/plugins/aify-comms/doctor-checks.mjs). Their tests were written against a `get(path)` fake that
// dispatches on the route, and keep it: this turns such a fake into the reads, spelling each route the
// way `CommsApi` sends it, so a fake keyed on the wrong route answers null exactly as the service would.
export function readsOf(get) {
  return {
    agents: () => get("/agents"),
    liveTerminals: () => get("/terminals?status=live&limit=500"),
    environments: () => get("/environments"),
    bridges: () => get("/bridges"),
    agentConsole: (agentId, lines) => get(`/agents/${encodeURIComponent(agentId)}/console?lines=${lines}`),
  };
}

/** A check's deps with a `get(path)` fake turned into `reads`. */
export function withReads({ get, ...deps }) {
  return { ...deps, reads: readsOf(get) };
}
