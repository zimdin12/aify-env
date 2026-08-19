// What a service may ask this environment to do.
//
// Pure request in, response out. The transport lives in bin/aify-env.mjs; every rule lives here, where
// it is pinned by tests that do not have to bind a port. A test that binds a port fails for reasons
// unrelated to the rule it was checking.
//
// REGISTRATION IS NOT AUTHORISATION. A request from a registered service is allowlist-checked exactly
// like any other. A host that runs whatever a known caller asks for is one compromised service away
// from running anything, and "it came from aify-comms" is not evidence about the file being started.
//
// A KNOWN TOCTOU, written down rather than hidden: the launcher is read to be judged and then started
// by path, so a file swapped between those two moments would be judged as one thing and run as
// another. Closing it properly needs execution from the descriptor that was read, which node does not
// offer. On a host where an attacker can rewrite files in the launcher directory they can also write a
// marker, so this window is not the weakest link — but it is a window, and the next person should know
// it is there rather than discover it.

import { mayExecute } from "./allowlist.mjs";
import { interpreterFor } from "./interpreter.mjs";

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const ok = (status, body) => ({ status, body });
const error = (status, message) => ({ status, body: { error: message } });

/**
 * @param {{method: string, path: string, body?: unknown}} request
 * @param {{runner: object, readFile: (path: string) => string, version: string, unknown?: object[]}} deps
 */
export async function handleRequest(request, deps) {
  const { method, path } = request;

  if (path === "/health") {
    if (method !== "GET") return error(405, `${method} is not supported on /health`);
    // Processes and the reaper's unanswerable set. Deliberately nothing about agents: alive is not
    // working, and a field here would make this a second place that answers for them.
    return ok(200, {
      status: "healthy",
      version: deps.version,
      processes: deps.runner.list(),
      unknown: deps.unknown ?? [],
      // Stated rather than inferred. A consumer that has to work out whether it got a terminal from
      // output that looks slightly wrong is a consumer that will get it wrong.
      terminals: deps.terminals ?? { available: false, reason: "not reported" },
      // This environment's OWN io, which is the only traffic it can honestly report: it has no
      // visibility into what a service does elsewhere.
      traffic: deps.traffic ?? { requests: 0, bytesOut: 0 },
    });
  }

  if (path === "/processes") {
    if (method === "GET") return ok(200, { processes: deps.runner.list() });
    if (method === "POST") return startProcess(request.body, deps);
    return error(405, `${method} is not supported on /processes`);
  }

  if (path.startsWith("/processes/")) {
    const id = path.slice("/processes/".length);
    if (method !== "DELETE") return error(405, `${method} is not supported on /processes/:id`);
    // Idempotent: a caller retrying a stop, or a reaper racing one, must not get an error for having
    // been second.
    await deps.runner.stop(id);
    return { status: 204, body: null };
  }

  return error(404, `no such endpoint: ${path}`);
}

async function startProcess(body, deps) {
  if (!isPlainObject(body)) {
    return error(400, "a start request must be a JSON object");
  }
  if (!body.service || typeof body.service !== "string") {
    // Every process has an owner, or the registry cannot say whose work it is and nothing downstream
    // can reason about orphans.
    return error(400, "a start request must name the service it is for");
  }
  if (!body.launcher || typeof body.launcher !== "string") {
    return error(400, "a start request must name a launcher to run");
  }

  let fileText;
  try {
    fileText = deps.readFile(body.launcher);
  } catch (readError) {
    // FAILS CLOSED. "I could not open it" must never become "go ahead".
    return error(403, `cannot read ${body.launcher}: ${readError.code ?? readError.message}`);
  }

  const verdict = mayExecute(fileText);
  if (!verdict.ok) {
    return error(403, `refused ${body.launcher}: ${verdict.reason}`);
  }

  // How to run it comes from the file we just judged, not from its name. On Windows nothing reads a
  // shebang, so a bash launcher spawned by path simply does not start -- and that failure arrives as
  // "the agent did not start" with no reason attached.
  const plan = interpreterFor(
    fileText,
    body.launcher,
    deps.platform ?? process.platform,
    Array.isArray(body.args) ? body.args : [],
  );

  const handle = await deps.runner.start({
    service: body.service,
    fileText,
    command: plan.command,
    args: plan.args,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: isPlainObject(body.env) ? body.env : undefined,
  });

  return ok(201, {
    id: handle.id,
    pid: handle.pid,
    // The caller has to know which it got: a PTY renders a TUI, pipes do not.
    terminal: handle.terminal,
    service: handle.service,
  });
}
