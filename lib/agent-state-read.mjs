// Definition availability is unresolved unless a launcher was positively observed.
// This read exposes facts only. current() remains the sole state derivation.
export async function readAgentStates({ stateHost, definitions, observedHarnesses } = {}) {
  const inputs = { operatorStop: "not-tracked" };
  const unavailable = (problem) => ({ status: 503, body: { agents: [], complete: false, problems: [problem], inputs } });
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
    const given = { stoppedByOperator: false, definition: undefined };
    if (trusted && reading.problems?.length === 0 && reading.agent) {
      given.mode = reading.agent.mode;
      if (installed.has(reading.agent.harness)) given.definition = "valid";
      else problems.push("launcher-not-observed");
    } else if (trusted && reading.problems?.length && !reading.problems.includes("entry: not-adopted")) given.definition = "invalid";
    else problems.push("definition-unresolved");
    givenById.set(reading.id, given);
  }
  for (const id of listed?.unreadable ?? []) givenById.set(id, { stoppedByOperator: false });
  const missingGiven = { stoppedByOperator: false };
  if (listed && !listed.enumerationFailed && !listed.conflict && !listed.unreadable?.length) missingGiven.definition = "none";
  try {
    const read = stateHost.readAll(givenById, missingGiven);
    return { status: 200, body: { agents: read.agents, complete: read.complete && problems.length === 0,
      problems: [...new Set([...problems, ...read.problems])].sort(), inputs } };
  } catch { return unavailable("state-refresh-failed"); }
}
