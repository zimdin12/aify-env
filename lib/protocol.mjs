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
      // WHICH CODE, not which release. `version` is the VERSION file and does not move for a fix;
      // this does. The TUI reads both from here rather than off disk, so what it shows is what
      // this process loaded -- the only reading that can answer "did my restart take?".
      build: deps.build ?? "",
      // WHO IS ANSWERING. A replacement instance has to be able to stop the incumbent, and asking it
      // beats scanning the process table: the port tells you which process to ask, and the answer says
      // whether it is one of ours at all. Killing whatever happens to hold a port is how you end
      // somebody else's server.
      pid: deps.pid ?? process.pid,
      // Uptime is DERIVED HERE, where a clock is allowed. The view is pure and must not hold one,
      // and it was reading a `uptimeMs` nobody supplied -- which is why every row read "up -".
      processes: deps.runner.list().map((entry) => ({
        ...entry,
        uptimeMs: Number.isFinite(entry.startedAtMs) ? Date.now() - entry.startedAtMs : null,
      })),
      unknown: deps.unknown ?? [],
      // LIFETIME, beside the current list. An empty `processes` is ambiguous exactly where it
      // matters -- idle, or broken -- and the operator read it as broken. Reported from this
      // environment's own counters; nothing here asks a service what its agents are doing.
      history: typeof deps.runner.history === "function"
        ? deps.runner.history()
        : { startedTotal: 0, lastExitAtMs: null },
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

  // A COMMAND THAT IS NOT A PATH CANNOT BE SPAWNED ON WINDOWS. node-pty says so by throwing
  // `File not found:`, which arrived as HTTP 500 "internal error" with nothing naming the cause.
  // An operator starting from a plain cmd prompt hit exactly this: no Git on PATH, both remaining
  // bashes are WSL doorways and correctly skipped, and the resolver fell back to the bare name.
  //
  // Refusing with the reason is the difference between "spawning is broken" and "install Git for
  // Windows, or put a POSIX shell on PATH".
  const runningOn = deps.platform ?? process.platform;
  // A plain check rather than a character class: '[/' + backslash + ']' builds `[/\]`, where the
  // backslash escapes the bracket and the class never closes. That threw inside the request handler
  // and became the very 500 this block exists to replace.
  const looksLikeAPath = (value) => value.includes("/") || value.includes(String.fromCharCode(92));
  if (runningOn === "win32" && plan.command && !looksLikeAPath(plan.command)) {
    return error(422,
      `cannot run ${body.launcher}: no POSIX shell was found to interpret it. "${plan.command}" is `
      + 'not a path, so it cannot be spawned. Install Git for Windows, or put a bash that can open '
      + "C: paths on PATH -- a WSL bash is deliberately skipped because it cannot open them.");
  }

  const handle = await deps.runner.start({
    service: body.service,
    fileText,
    command: plan.command,
    args: plan.args,
    // The caller's own name for this work -- an agent id, in aify-comms' case. aify-env stores and
    // displays it and never reads meaning into it: `p2  pid 129340  aify-comms` cannot tell an
    // operator WHICH of their agents that is, and knowing what an agent IS is not this tier's job.
    label: typeof body.label === "string" ? body.label : "",
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
