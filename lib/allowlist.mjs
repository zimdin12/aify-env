// What this environment is willing to execute.
//
// aify-env runs processes on behalf of whichever service asks. That is remote code execution by
// design, and the constraint that made the predecessor safe — it only ever launched wrappers — was
// incidental rather than enforced. This module is the enforcement.
//
// DERIVED, NOT LISTED. A file may run if it carries the harness contract marker that every wrapper
// already has. Installing a wrapper enrols it, nobody edits a policy file, and a new harness works
// without anyone remembering a list. A list you must remember to update is a defect with a delay on it.
//
// READ, NEVER RUN. Deciding whether to execute a file by executing it is the exact shape of the bug
// that took down a fleet: asking a pre-contract wrapper `--check` forwards the flag to the runtime and
// launches it. Everything here is a string predicate — no filesystem, no spawn, no import of the
// thing being judged.
//
// WHAT IT DOES NOT CLAIM. The marker says "this file speaks the harness contract", not "this file is
// safe". Anything that can write to the launcher directory can write a marker, so on a shared host the
// installed set has to be recorded at install time as well. Locally, anything that can write there
// already owns the machine, and the marker is the honest bound.

/** A NUL byte means this was never a script. Named, because a raw one in source makes THIS file binary. */
const NUL = String.fromCharCode(0);

/** The contract marker every wrapper carries, as a real shell assignment at the start of a line. */
const MARKER_PATTERN = /^[ \t]*HARNESS_WRAPPER_VERSION[ \t]*=[ \t]*"([^"]*)"[ \t]*$/m;

/**
 * The contract version a file declares, or null when it declares none.
 *
 * Anchored to a line start and required to be an assignment, so a file that merely MENTIONS the name
 * — in prose, in a comment, in a disabled line — is not enrolled by it. A substring check is what
 * anyone writes first and it is exactly wrong here: a script telling you how to enrol would enrol
 * itself.
 *
 * Returns null, never "", so a caller testing truthiness of a version gets one answer for absent.
 *
 * @param {unknown} fileText
 * @returns {string|null}
 */
export function markerOf(fileText) {
  if (typeof fileText !== "string") return null;
  const match = MARKER_PATTERN.exec(fileText);
  if (!match) return null;
  const version = match[1].trim();
  return version === "" ? null : version;
}

/**
 * May this file be executed?
 *
 * FAILS CLOSED on everything it cannot make sense of — a non-string, an unreadable blob, an empty
 * file. A caller that could not read the file must not accidentally get a yes, because the cost of a
 * wrong yes here is running an arbitrary program as the operator.
 *
 * @param {unknown} fileText
 * @returns {{ok: boolean, reason: string, version: string|null}}
 */
export function mayExecute(fileText) {
  if (typeof fileText !== "string") {
    return refuse("not readable as text", null);
  }
  if (fileText.trim() === "") {
    return refuse("the file is empty", null);
  }
  // A NUL byte means this was never a script. Say so specifically rather than letting it fall through
  // to the generic marker refusal, which would send a reader looking for a missing line.
  if (fileText.includes(NUL)) {
    return refuse("the file is binary", null);
  }

  // A template rendered with a missing KEY=VALUE keeps its placeholder. render.sh already refuses that
  // at install; this is the same refusal at the point of execution, because a launcher whose version
  // was never substituted was never verified by anything that checks versions.
  if (/^[ \t]*HARNESS_WRAPPER_VERSION[ \t]*=[ \t]*"@@[A-Z0-9_]+@@"/m.test(fileText)) {
    return refuse("the version marker still holds an unsubstituted placeholder", null);
  }

  // A LAUNCHER DECLARES ITS INTERPRETER. Found by review: this module's own README passed the marker
  // check, because it documents the contract and therefore carries the marker line at column zero
  // inside a code fence.
  //
  // The consequence is not "bash would error on a .md". It is that the property being claimed — this
  // file speaks the harness contract — was not the property being checked. aify-env executes a path a
  // CALLER supplies, so any file on the host that quotes the contract was enrolled by quoting it: a
  // README, a captured log, a pasted snippet.
  //
  // Requiring a shebang costs nothing real. Every wrapper this project ships opens with one, and
  // `interpreterFor` already reads it to decide how to start a launcher — so the two now agree about
  // what a launcher is instead of disagreeing quietly.
  if (!/^#![ \t]*\S/.test(fileText)) {
    return refuse(
      "no shebang on the first line: a launcher declares the interpreter that runs it, and a file that "
      + "merely quotes the contract marker is documentation rather than something to execute",
      null,
    );
  }

  const version = markerOf(fileText);
  if (version === null) {
    return refuse(
      "no HARNESS_WRAPPER_VERSION marker: aify-env runs launchers that speak the harness contract, "
      + "and enrolment is by carrying that marker rather than by being named in a list",
      null,
    );
  }

  return { ok: true, reason: "", version };
}

function refuse(reason, version) {
  return { ok: false, reason, version };
}
