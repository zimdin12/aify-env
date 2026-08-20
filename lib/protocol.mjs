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
/**
 * The routes, as a table.
 *
 * This was one 74-line if-chain, and a router's whole job is to be readable at a glance: which paths
 * exist, which methods each takes, what answers. A reader who has to trace five nested branches to
 * learn that is reading an implementation instead of a specification.
 *
 * `match` returns the captured id, or null when the path is not this route. Order matters only for the
 * two `/processes/:id/...` routes, which must be tried before the bare `/processes/:id`.
 */
const ROUTES = [
  {
    name: "/health",
    methods: ["GET"],
    match: (path) => (path === "/health" ? "" : null),
    handle: (_id, _request, deps) => ok(200, {
      status: "healthy",
      version: deps.version,
      processes: deps.runner.list(),
      unknown: deps.unknown ?? [],
      // Stated rather than inferred. A consumer that has to work out whether it got a terminal from
      // output that looks slightly wrong is a consumer that will get it wrong.
      terminals: deps.terminals ?? { available: false, reason: "not reported" },
      // This environment's OWN io, the only traffic it can honestly report.
      traffic: deps.traffic ?? { requests: 0, bytesOut: 0 },
    }),
  },
  {
    name: "/processes/:id/output",
    methods: ["GET"],
    match: (path) => captureId(path, "/output"),
    handle: (id, _request, deps) => {
      // Answered here, streamed by the transport. A caller must be able to tell "no such process" from
      // "a process that has printed nothing yet": one is a 404, the other an open stream that is simply
      // quiet, and conflating them makes a console look broken for a reason nobody can see.
      if (!deps.runner.canStream(id)) return error(404, `no such process: ${id}`);
      return { status: 200, body: null, stream: id };
    },
  },
  {
    name: "/processes/:id/input",
    methods: ["POST"],
    match: (path) => captureId(path, "/input"),
    handle: (id, request, deps) => {
      if (!isPlainObject(request.body) || typeof request.body.data !== "string") {
        return error(400, "an input request must carry a string `data`");
      }
      const written = deps.runner.write(id, request.body.data);
      // Refused rather than silently dropped: a console typing into a process that has gone must be
      // told, or the operator types into a void and concludes the agent is ignoring them.
      if (!written.ok) return error(404, written.error);
      return { status: 204, body: null };
    },
  },
  {
    name: "/processes/:id/resize",
    methods: ["POST"],
    match: (path) => captureId(path, "/resize"),
    handle: (id, request, deps) => {
      if (!isPlainObject(request.body)) return error(400, "a resize request must be a JSON object");
      const resized = deps.runner.resize(id, request.body.cols, request.body.rows);
      // 409 rather than 404 when there is simply no terminal: the process exists, the request does not
      // apply to it, and a console must tell those apart before it decides to retry.
      if (!resized.ok) {
        return error(/no such process/i.test(resized.error) ? 404 : 409, resized.error);
      }
      return { status: 204, body: null };
    },
  },
  {
    name: "/processes",
    methods: ["GET", "POST"],
    match: (path) => (path === "/processes" ? "" : null),
    handle: (_id, request, deps) => (request.method === "GET"
      ? ok(200, { processes: deps.runner.list() })
      : startProcess(request.body, deps)),
  },
  {
    name: "/processes/:id",
    methods: ["DELETE"],
    match: (path) => (path.startsWith("/processes/") ? path.slice("/processes/".length) : null),
    handle: async (id, _request, deps) => {
      // Idempotent: a caller retrying a stop, or a reaper racing one, must not get an error for having
      // been second.
      await deps.runner.stop(id);
      return { status: 204, body: null };
    },
  },
];

/** `/processes/<id><suffix>` -> id, or null. */
function captureId(path, suffix) {
  if (!path.startsWith("/processes/") || !path.endsWith(suffix)) return null;
  const id = path.slice("/processes/".length, -suffix.length);
  return id === "" ? null : id;
}

/**
 * @param {{method: string, path: string, body?: unknown}} request
 * @param {{runner: object, readFile: (path: string) => string, version: string, unknown?: object[]}} deps
 */
export async function handleRequest(request, deps) {
  for (const route of ROUTES) {
    const id = route.match(request.path);
    if (id === null) continue;
    // Method checked per route, so an unsupported verb on a real path is 405 and never a silent GET.
    if (!route.methods.includes(request.method)) {
      return error(405, `${request.method} is not supported on ${route.name}`);
    }
    return route.handle(id, request, deps);
  }
  return error(404, `no such endpoint: ${request.path}`);
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
