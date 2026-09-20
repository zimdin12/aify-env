// WHO HOLDS THIS PORT, and is it one of ours?
//
// THE ANSWER DECIDES WHOSE PROCESS TREE GETS KILLED, which is why it lives in a file of its own with
// its own tests rather than inside the entry point. It left `bin/aify-env.mjs` when that file crossed
// the 1000-line gate: the question is self-contained -- a host, a port, and a shape test -- and the
// entry point only ever needed the answer.

import { looksLikeEnvironment } from "./environment-checks.mjs";

/**
 * @returns {Promise<{pid: number, version: string, processes: unknown}|null>} null when nothing
 *   answers, when the answer is not an aify-env, or when it carries no pid to act on.
 */
export async function askIncumbent({ host, port, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  try {
    const response = await fetchImpl(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    // IDENTIFIED BY SHAPE, because the answer to this question decides whose process tree gets killed.
    // `status: "healthy"` plus a pid was the old test, and it is the most common health body in
    // existence -- any dev server, any sidecar, anything at all that serves JSON on this port and
    // reports its own pid passed it, and `killTree` took the pid on the next line. The doctor had
    // already been hardened against exactly this (see `looksLikeEnvironment`, which describes a
    // responder mistaken for an environment on the strength of `{"status":"healthy"}`); the KILL path
    // was left on the weak test. An aify-env is recognised by what it OWNS -- a `processes` array and
    // a `terminals` object, both of which /health above always sends -- and nothing else on a host has
    // reason to report those.
    if (!looksLikeEnvironment({ ok: true, status: response.status, body })) return null;
    // `processes` travels with the pid: a takeover ENDS them, so the caller must be able to say what
    // it is about to cost before it costs it.
    if (Number.isInteger(body?.pid)) {
      return { pid: body.pid, version: body.version, processes: body.processes };
    }
    return null;
  } catch {
    return null;
  }
}
