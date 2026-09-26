// What a start or a stop chosen in the view turned out to be, as one line for NOTICES.
//
// THE DEFECT THIS EXISTS FOR (v0.7 scan, F9). Both were fire-and-forget: a service refusing a start
// ("it has a live session") and a stop that failed were each swallowed, so the operator could not
// tell a refusal from a slow start, or a failed stop from a slow one.
//
// TWO SHAPES MEET HERE. A start answers `{started, problem}` from either tier. A stop answers
// `{ok, problem}` from both, and `ok` means the process is GONE, checked after the kill (v0.7.1
// review, E8); a bare boolean is still read, for a caller that has nothing more to say. A handler that
// answers NOTHING claims nothing, and gets no line: inventing "stopped" for a caller that never said
// would be a notice that lies.

/** The line for a start, or "" when there is nothing to say. */
export function startOutcomeNotice(agent, result) {
  const name = String(agent?.name || agent?.id || "an agent");
  if (!result || typeof result !== "object") return "";
  if (result.started === true) return `starting ${name}`;
  return `start of ${name} refused: ${String(result.problem || "no reason given")}`;
}

/** The line for a confirmed action on a process, or "" when there is nothing to say. */
export function actionOutcomeNotice(perform, result) {
  const action = String(perform?.action ?? "");
  const name = String(perform?.process?.label || perform?.process?.id || "a process");
  let ok;
  let problem = "";
  if (typeof result === "boolean") {
    ok = result;
  } else if (result && typeof result === "object" && typeof result.ok === "boolean") {
    ok = result.ok;
    problem = String(result.problem || "");
  } else {
    return "";
  }
  if (ok) return action === "stop" ? `stopped ${name}` : `${action} ${name}: done`;
  return `${action} of ${name} failed: ${problem || "the environment did not accept it"}`;
}
