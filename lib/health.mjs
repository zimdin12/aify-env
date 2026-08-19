// The result shape a verifier reports: passed, failed, or UNANSWERED.
//
// The third state is the reason this file exists. The verifier this succeeds has two states and a
// skip, and the skip pushes ok:true — so on Windows, where two of its twelve checks read /proc and
// skip, a green --strict run means ten verified and two unanswerable. That is survivable at twelve
// checks on one host. Across four components, where "not installed" and "silent" become the ordinary
// cases, it stops being survivable: green drifts toward meaning nothing.
//
// Two false greens in this project's history are the same bug: a check reporting "2 connected" with
// zero bridges alive, and a check that was green-by-default whenever nothing reported at all. Both
// were checks that could not gather evidence and said so as a pass.
//
// There is deliberately no boolean anywhere in the result. A two-valued field is how a third state
// gets quietly collapsed back into a pass by the next person to write a summary line.

export const STATE = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  UNANSWERED: "unanswered",
});

/**
 * Exit statuses. UNANSWERED gets its own so a caller can tell "everything I could check was fine, and
 * some things I could not check" from "everything was fine".
 */
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  UNANSWERED: 2,
});

export function passed(id, detail) {
  return { id, state: STATE.PASSED, detail: String(detail ?? ""), fix: "" };
}

/**
 * A failure, with the remedy. A failure without one is a complaint: it tells a reader something is
 * wrong and leaves them to work out what to do, which is the part that costs the time.
 */
export function failed(id, detail, fix) {
  if (!fix || String(fix).trim() === "") {
    throw new Error(`check ${id}: a failed check must carry a fix`);
  }
  return { id, state: STATE.FAILED, detail: String(detail ?? ""), fix: String(fix) };
}

/**
 * Could not gather evidence, and why.
 *
 * The reason is required. "Unanswered" with no reason is indistinguishable from a bug in the checker
 * itself, and the reader cannot tell whether to chase the service or the tool.
 */
export function unanswered(id, reason) {
  if (!reason || String(reason).trim() === "") {
    throw new Error(`check ${id}: an unanswered check must carry a reason`);
  }
  return { id, state: STATE.UNANSWERED, detail: String(reason), fix: "" };
}

/**
 * Roll a set of checks into a verdict.
 *
 * An EMPTY set is unanswered, never ok: a verifier that gathered nothing has verified nothing, and
 * reporting that as healthy is the precise false green this module exists to prevent.
 */
export function summarise(checks) {
  const list = [...(checks ?? [])];
  const counts = {
    passed: list.filter((check) => check.state === STATE.PASSED).length,
    failed: list.filter((check) => check.state === STATE.FAILED).length,
    unanswered: list.filter((check) => check.state === STATE.UNANSWERED).length,
  };

  if (list.length === 0) {
    return {
      checks: list,
      counts,
      exitCode: EXIT.UNANSWERED,
      summary: "no checks ran, so nothing was verified",
    };
  }

  // A known failure outranks an unanswerable one: a reader fixing one thing should be pointed at the
  // thing that is known broken rather than at the thing nobody could reach.
  const exitCode = counts.failed > 0
    ? EXIT.FAILED
    : counts.unanswered > 0 ? EXIT.UNANSWERED : EXIT.OK;

  const named = (state) => list.filter((check) => check.state === state).map((check) => check.id);
  const parts = [`${counts.passed} passed`];
  if (counts.failed) parts.push(`${counts.failed} failed (${named(STATE.FAILED).join(", ")})`);
  if (counts.unanswered) parts.push(`${counts.unanswered} unanswered (${named(STATE.UNANSWERED).join(", ")})`);

  return { checks: list, counts, exitCode, summary: parts.join(", ") };
}
