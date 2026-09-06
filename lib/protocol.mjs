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

import { buildStartSpec } from "./start-spec.mjs";

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
      // AND WHAT IS ON DISK NOW, so the comparison does not need a second command and a human eye.
      // `build` is what this process LOADED; equal means current, different means a restart would
      // pick something up. Both travel rather than a boolean: an operator told to restart -- which
      // reaps this daemon's managed workers -- is owed the two identities behind the advice.
      // EMPTY WHEN UNKNOWN, never a guess: a caller that cannot compute it omits it, and a reader
      // must treat the absence as `cannot tell` rather than as a mismatch.
      codeOnDisk: deps.codeOnDisk ?? "",
      // WHO IS ANSWERING. A replacement instance has to be able to stop the incumbent, and asking it
      // beats scanning the process table: the port tells you which process to ask, and the answer says
      // whether it is one of ours at all. Killing whatever happens to hold a port is how you end
      // somebody else's server.
      pid: deps.pid ?? process.pid,
      // WHICH INSTANCE MINTED THE HANDLES BELOW. Process ids are unique within an instance and
      // nowhere else -- a restart used to mint `p1` again, for a different agent on a different pid,
      // and a consumer holding a handle across the outage got YES to "is p1 still listed" about a
      // stranger. The id itself carries this now, so a stale handle simply does not match; this field
      // is here so a consumer can SAY which instance answered rather than only fail to match.
      instance: typeof deps.runner.instance === "function" ? deps.runner.instance() : "",
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
      // WHO IS ADVERTISING THIS HOST. Exactly one tier may describe a host's runtimes and roots --
      // two writing the same last-writer-wins fields flap the row, and none leaves it stale. The
      // aify-comms bridge omits host facts when this is true, and resumes sending them when it is
      // false or when this daemon does not answer at all. Defaults to FALSE: a daemon too old to
      // report it is one that is not advertising, and the bridge must keep the job.
      advertising: deps.advertising === true,
      // PER SERVICE, because "am I advertising?" has no single answer once there is more than one
      // consumer. The scalar above was `enabled && targets.length > 0` and consulted no result, so
      // a target answering 401 or 500 still reported true and its bridge stood down for a beat it
      // never received. Each entry records the last ACCEPTED beat, so a consumer can ask about
      // ITSELF: `advertisingTo["aify-comms"].fresh`. A consumer that does not find its own name
      // must keep advertising -- absence is not evidence that it was told.
      advertisingTo: deps.advertisingTo ?? {},
      // WHETHER ADVERTISING IS ARMED AT ALL, which is a different question from whether it is being
      // heard. `AIFY_ADVERTISE=0` hands the job back to the bridge deliberately, so a host with no
      // credential is configured exactly as intended and must not be reported as broken.
      //
      // NULL WHEN NOT REPORTED, never `false`. A daemon too old to send this has said nothing, and
      // defaulting to `false` would turn that silence into "advertising is off" -- which reads as a
      // PASS and hides the very host the credential rows exist to find.
      advertisingEnabled: deps.advertisingEnabled ?? null,
      // NAMES AND A BOOLEAN, never a key.
      //
      // THESE THREE WERE COMPUTED AND DROPPED HERE, which is why `advertise-cred` read `??` on every
      // host. `bin/aify-env.mjs` builds all of them and passes them as deps; this handler forwarded
      // `advertising` and `advertisingTo` and let the rest fall on the floor, so
      // `environment-report.mjs` read `body.advertiseCredentials` and got `undefined` forever. The
      // check then said "restart it on a build that does" -- advice for a build that has never
      // existed, sending an operator to reap their own managed workers for nothing.
      //
      // A producer and a reader pointed at different carriers, with a middle layer that drops the
      // field: both ends had tests and both were green, because each supplied the other's side.
      advertiseCredentials: deps.advertiseCredentials ?? null,
      // The outcome of the last beat per target, so a reader can tell a refusal from an outage.
      advertiseAttempts: deps.advertiseAttempts ?? null,
      // WHAT EACH SERVICE PLUGIN IS DOING, which `advertising` above does NOT answer. Advertising
      // DESCRIBES this machine; a plugin CLAIMS work on it, and those are separate capabilities on
      // purpose -- the split exists so a host with no claimer stops reading as ready. On 2026-09-02
      // the advertiser was healthy for hours while the aify-comms plugin's every heartbeat was
      // discarded, `/spawn` refused six times, and this endpoint reported only the half that worked.
      // An operator asking "is aify-env working" got yes.
      //
      // AN EMPTY ARRAY IS A REAL ANSWER -- no plugin started -- and is distinguishable from a daemon
      // too old to have the field at all, which is what a reader gets for `undefined`.
      plugins: deps.plugins ?? [],
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
    // WHO THIS IS, ARRIVING LATE. `POST /processes` takes a label because the caller usually knows
    // the answer at spawn time. It does not always: a launcher can start with no identity and
    // register itself mid-conversation, and the operator's rule is that a wrapper registered later
    // must end up indistinguishable from one registered at launch. So the label is a value that can
    // be corrected, not a fact fixed at birth.
    //
    // STILL MEANINGLESS TO THIS TIER. aify-env stores and displays it and reads nothing into it,
    // exactly as at spawn. What changed is when it may be told, not what it understands.
    name: "/processes/:id/label",
    methods: ["POST"],
    match: (path) => captureId(path, "/label"),
    handle: (id, request, deps) => {
      const body = request.body;
      if (!isPlainObject(body)) {
        return error(400, "a label request must be a JSON object");
      }
      if (typeof body.label !== "string") {
        return error(400, "a label request must carry a string label");
      }
      // NOT FOUND IS A 404, not a silent success. A caller reconciling labels has to be able to
      // tell 'I relabelled it' from 'that process is gone', or it will keep trying forever.
      if (!deps.runner.relabel(id, body.label)) {
        return error(404, `no such process: ${id}`);
      }
      return { status: 204, body: null };
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
  // ONE SPEC BUILDER, shared with the service plugins that run inside this process. Two copies
  // would agree only until one was fixed, and the half that rots is the one nobody runs by hand.
  const built = buildStartSpec({
    service: body.service,
    launcher: body.launcher,
    args: body.args,
    cwd: body.cwd,
    env: isPlainObject(body.env) ? body.env : undefined,
    label: body.label,
  }, { readFile: deps.readFile, platform: deps.platform ?? process.platform });
  if (built.error) return error(built.error.status, built.error.detail);

  const handle = await deps.runner.start(built.spec);

  return ok(201, {
    id: handle.id,
    pid: handle.pid,
    // The caller has to know which it got: a PTY renders a TUI, pipes do not.
    terminal: handle.terminal,
    service: handle.service,
  });
}
