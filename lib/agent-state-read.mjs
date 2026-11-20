import { definitionsOutsideRoots } from "./definition-checks.mjs";

// Definition availability is unresolved unless a launcher was positively observed.
// This read exposes facts only. current() remains the sole state derivation.
// A managed definition whose workspace is outside `cwdRoots` is "unavailable": this host refuses every start of it
// (0.9.2, "an agent its environment will not start reads misconfigured"), whatever launcher is installed. The doctor's
// agents-outside-roots row asks the same predicate. No roots means no judgement, as before. `cwdRoots` may be a function,
// asked once per read, so a launch root added on this host (lib/launch-roots.mjs) reaches the next read.
// The Runner supplies screen sightings with an exact handle and lifetime. A failed screen read leaves the turn and
// process evidence usable and reports `inputs.screens: "unavailable"`; it does not hide the agent population.
export async function readAgentStates({ stateHost, definitions, observedHarnesses, lifecycle, cwdRoots = null,
  screens = () => [], windows = process.platform === "win32" } = {}) {
  const roots = typeof cwdRoots === "function" ? cwdRoots() : cwdRoots;
  const outsideRoots = (reading) => Array.isArray(roots) && roots.length > 0
    && definitionsOutsideRoots([reading], roots, { windows }).length > 0;
  const inputs = { operatorStop: "unavailable" };
  const unavailable = (problem) => ({ status: 503, body: { agents: [], complete: false, problems: [problem], inputs } });
  let stops;
  try {
    stops = await lifecycle.stopFacts();
    if (!(stops instanceof Map)) throw Error('invalid stop map');
    inputs.operatorStop = "tracked";
  } catch { return unavailable("operator-stop-unavailable"); }
  if (typeof stateHost?.readAll !== "function") return unavailable("state-unavailable");
  const problems = [];
  let listed = null;
  try { listed = await definitions.list(); } catch { problems.push("definition-read-failed"); }
  let installed = new Set();
  try { installed = await observedHarnesses(); } catch { problems.push("launcher-observation-failed"); }
  if (!(installed instanceof Set)) { installed = new Set(); problems.push("launcher-observation-failed"); }
  if (listed?.enumerationFailed) problems.push("definition-enumeration-failed");
  if (listed?.conflict) problems.push("definition-conflict");
  if (listed?.unreadable?.length) problems.push("definition-unreadable");
  const givenById = new Map();
  const trusted = listed && !listed.conflict;
  for (const reading of listed?.definitions ?? []) {
    const given = { stoppedByOperator: stops.get(`${listed.storeId}:${reading.incarnation}:${reading.id}`) === true, definition: undefined };
    if (trusted && reading.problems?.length === 0 && reading.agent) {
      given.mode = reading.agent.mode;
      if (outsideRoots(reading)) given.definition = "unavailable";
      else if (installed.has(reading.agent.harness)) given.definition = "valid";
      else problems.push("launcher-not-observed");
    } else if (trusted && reading.problems?.length && !reading.problems.includes("entry: not-adopted")) given.definition = "invalid";
    else problems.push("definition-unresolved");
    givenById.set(reading.id, given);
  }
  for (const id of listed?.unreadable ?? []) givenById.set(id, { stoppedByOperator: false });
  const missingGiven = { stoppedByOperator: false };
  if (listed && !listed.enumerationFailed && !listed.conflict && !listed.unreadable?.length) missingGiven.definition = "none";
  const sightings = new Map();
  try {
    for (const seen of screens()) {
      if (seen?.handle && seen.lifetime && typeof seen.state === 'string') sightings.set(seen.handle, seen);
    }
  } catch { inputs.screens = 'unavailable'; }
  try {
    const read = stateHost.readAll(givenById, missingGiven, sightings);
    const defined = new Map((trusted ? listed.definitions ?? [] : []).filter((r) => r.agent && r.problems?.length === 0)
      .map((r) => [r.id, r.agent]));
    const agents = read.agents.map((row) => ({ ...row, name: defined.get(row.agentId)?.name ?? null,
      role: defined.get(row.agentId)?.role ?? null }));
    return { status: 200, body: { agents, complete: read.complete && problems.length === 0,
      problems: [...new Set([...problems, ...read.problems])].sort(), inputs } };
  } catch { return unavailable("state-refresh-failed"); }
}
