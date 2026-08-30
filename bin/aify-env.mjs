#!/usr/bin/env node
// aify-env: the environment for this host.
//
// Owns processes and terminals so that more than one service can start agents here without two
// spawners fighting over the same PTYs. Knows nothing about messages, dispatch, or whether an agent is
// thinking.
//
// BINDS LOOPBACK ONLY, and that is not a default to be overridden lightly. This process starts programs
// on request; reachable from another machine it is a remote shell with a JSON interface. The host is
// fixed rather than configurable for the same reason a guard that can be turned off is decoration.
//
//   aify-env                 run in the foreground on 127.0.0.1:8802, showing the live view
//   aify-env doctor          what this host can say about itself, and what each service said
//   aify-env tui             the live view alone, against a daemon already running
//   aify-env --port 0        pick an ephemeral port (used by tests)
//   aify-env --version
//
// ONE command on PATH, with subcommands. Three sibling binaries is what collided with aify-comms'
// own `aify-doctor`; a collision is only the loud version of the problem.
//
// There is deliberately no `--host`.
//
// THE VIEW OPENS IN THE TERMINAL THAT STARTS IT, and only there: piped or redirected output keeps the
// plain banner, because escapes in a log are noise and the banner is what a service manager parses.
// `AIFY_NO_DASHBOARD=1` opts out. What the view shows about AGENTS is relayed from each service and
// attributed to it -- this environment knows which processes it started, and alive is not working.

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest } from "../lib/protocol.mjs";
import { createReaper } from "../lib/reaper.mjs";
import { createShutdown } from "../lib/shutdown.mjs";
import { startDashboard } from "../lib/dashboard.mjs";
import { Runner, terminalSupport } from "../lib/runner.mjs";
import { clearOwned, entriesOwnedElsewhere, readOwned } from "../lib/owned-processes.mjs";
import { defaultVerify, planOrphanReap } from "../lib/orphan-reap.mjs";
import { killTree } from "../lib/kill-tree.mjs";
import { defaultIsAlive } from "../lib/reaper.mjs";
import { homedir, hostname } from "node:os";
import { buildIdentity, sourceFiles } from "../lib/build-identity.mjs";
import { browserOriginatedRequest } from "../lib/browser-requests.mjs";
import { readServices } from "../lib/services.mjs";
import {
  advertiseTo,
  advertisementTargets,
  advertisingEnabled,
  capabilityFingerprint,
  advertisementHealth,
  advertisementStaleMs,
  environmentAdvertisement,
  environmentKind,
  environmentOs,
  installedHarnesses,
  machineIdFor,
  runtimeAvailability,
  shouldRedetect,
} from "../lib/advertise.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

// WHAT IS ACTUALLY LOADED, computed from the files on the way in. `VERSION` says which release
// this claims to be and does not move for a bug fix; BUILD moves whenever the code does, which is
// the question an operator restarting to pick up a fix is actually asking. See
// lib/build-identity.mjs for why it is a content hash rather than a git sha.
//
// Read at BOOT, deliberately. A build computed on demand would report whatever is on disk NOW,
// which is the one answer that cannot tell you whether this process needs restarting.
const BUILD = buildIdentity(
  sourceFiles(ROOT, (dir) => readdirSync(dir), join),
  (path) => readFileSync(path, "utf8"),
  // Hashed under its path RELATIVE to the package, so the same code installed in two places
  // reports the same build. An absolute path would make every install look different.
  (path) => path.slice(ROOT.length).split(String.fromCharCode(92)).join("/"),
);

/** Never configurable. See above. */
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8802;

const args = process.argv.slice(2);
if (args.includes("--version")) {
  // BOTH, because one of them is the useful one. This prints what is on DISK; the running
  // daemon's banner prints what IT loaded. Equal means current, different means restart -- and
  // neither number needs to mean anything on its own for that comparison to be exact.
  process.stdout.write(`aify-env ${VERSION} (build ${BUILD})\n`);
  process.exit(0);
}
// SUBCOMMANDS, not sibling binaries. One product should put one command on PATH: three of them is what
// collided with aify-comms' own `aify-doctor`, and a collision is only the loud version of the problem
// -- the quiet one is a reader having to know which of three commands answers their question.
//
// An UNKNOWN subcommand is refused rather than falling through. Falling through would mean a typo like
// `aify-env doctr` silently STARTS the environment, which supersedes a running daemon and reaps its
// managed workers -- the one mistake here that costs someone their fleet.
const SUBCOMMANDS = { doctor: "./aify-env-doctor.mjs", tui: "./aify-env-tui.mjs" };
const firstArg = args[0];
if (firstArg && !firstArg.startsWith("-")) {
  const target = SUBCOMMANDS[firstArg];
  if (!target) {
    const known = Object.keys(SUBCOMMANDS).join(", ");
    // Its OWN newline, not the module-level `chr10`, which is declared further down and would be in
    // the temporal dead zone here. This file has already shipped that exact bug once, in this exact
    // variable, and it only fired when there was something to report.
    const eol = String.fromCharCode(10);
    process.stderr.write(`aify-env: unknown subcommand '${firstArg}'. Known: ${known}.` + eol);
    process.stderr.write("aify-env with no subcommand starts the environment." + eol);
    process.exit(64);
  }
  process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
  await import(target);
  process.exit(0);
}

const portFlag = args.indexOf("--port");
const port = portFlag === -1 ? DEFAULT_PORT : Number(args[portFlag + 1]);

const chr10 = String.fromCharCode(10);
/** SSE frames end with a BLANK line: two newlines. Named so nothing has to escape them. */
const FRAME_END = chr10 + chr10;

// WHAT THIS ENVIRONMENT OWNS, on disk.
//
// The in-memory registry cannot answer for an instance that has already died, and every agent such an
// instance started is still running with nothing able to name them. The record is the authority, and
// the next instance cleans up from it.
const OWNED_FILE = process.env.AIFY_ENV_PROCESS_RECORD || join(homedir(), ".aify", "env-processes.json");

// REAP ONLY ONCE THE PORT IS OURS. Everything in the record belongs to whichever instance wrote it,
// and it is an ORPHAN only if nobody is still serving. Holding the port is what proves that.
//
// This ran BEFORE listening, and the order was the bug: a second start read the record of the instance
// already running, found its processes alive and verifiably ours, killed them as orphans, and only
// then discovered the port was taken and exited. The incumbent kept serving, robbed of its agents.
// Proven with a real process in tests/a-second-start-does-not-rob-the-first.test.js.
//
// The killing decision still fails CLOSED: a pid that cannot be confirmed as ours is left alone and
// reported. Pid reuse is real, and ending a stranger's process is a worse failure than the leak.
async function reapLeftovers() {
  // READ ONCE, so what is spared and what is written back are the same list.
  const recorded = readOwned(OWNED_FILE);
  // `ownerIsAlive` is the guard the port could not be: an entry written by an instance that is STILL
  // RUNNING belongs to that instance, not to a crash. Holding the port proves nobody else is serving
  // only when the port is a fixed one -- `--port 0` takes an ephemeral port that is always free, so
  // this function ran in full for a daemon that owned nothing and reaped a live environment's fleet.
  const leftovers = planOrphanReap(recorded, {
    isAlive: defaultIsAlive,
    verify: defaultVerify,
    ownerIsAlive: defaultIsAlive,
  });
  for (const entry of leftovers.reap) {
    // The TREE, not the pid: the recorded process is a launcher, and the agent it started is a child of
    // it. Reaping only the launcher leaves exactly the process an operator cared about.
    const killed = await killTree(entry.pid);
    process.stderr.write(killed
      ? `[aify-env] reaped orphan pid ${entry.pid} (${entry.service}) and its children, from a previous instance${chr10}`
      : `[aify-env] could not reap pid ${entry.pid} (${entry.service})${chr10}`);
  }
  for (const { entry, reason } of leftovers.skipped) {
    // Said out loud rather than swallowed. "Left running because we could not prove it was ours" is
    // something an operator must be able to act on.
    if (reason !== "already gone") {
      process.stderr.write(`[aify-env] left pid ${entry.pid} (${entry.service}) alone: ${reason}${chr10}`);
    }
  }
  // KEEP WHAT BELONGS TO A LIVE INSTANCE. This was an unconditional empty, which undid the guard
  // above: the reaper spared another environment's processes and then deleted the only record that
  // they exist. Sparing a process and forgetting it is barely better than killing it -- the operator
  // still ends up with something running that nothing can clean up.
  clearOwned(OWNED_FILE, { keep: entriesOwnedElsewhere(recorded, { ownerIsAlive: defaultIsAlive }) });
}

const runner = new Runner({ ownedFile: OWNED_FILE });

// An escape hatch for anyone who wants the daemon in a terminal without the view taking it over.
const NO_DASHBOARD = ["1", "true", "yes"].includes(
  String(process.env.AIFY_NO_DASHBOARD ?? "").trim().toLowerCase(),
);
/** Set once the view is running, so shutdown can stop redrawing before it tears anything down. */
let stopDashboard = () => {};

// AND DIE TOGETHER — one path, in lib/shutdown.mjs, because there were two here and they disagreed.
//
// The other handler closed the server and exited on the grounds that this environment going down was
// not a reason to kill somebody else's agent. Node runs every listener, so the winner was whichever
// reached process.exit first, and that was the one NOT stopping anything. The operator's rule settles
// it: if aify-env dies, the processes it handles die with it.
//
// The record on disk still covers the hard kill that runs no handler at all. Both halves are needed.
const shutdown = createShutdown({
  runner,
  // Stop redrawing first: a frame landing mid-teardown paints a screen already untrue.
  beforeStop: () => stopDashboard(),
  // A FUNCTION, so `server` is looked up when a signal arrives rather than read here, where it is
  // still in its temporal dead zone.
  closeServer: () => server.close(),
  // OURS ONLY, on the way out too. Shutdown emptied the whole file, so an environment stopping
  // normally erased a concurrently-running instance's record exactly as the boot reap did.
  clearOwned: () => clearOwned(OWNED_FILE, {
    keep: entriesOwnedElsewhere(readOwned(OWNED_FILE), { ownerIsAlive: defaultIsAlive }),
  }),
  exit: (code) => process.exit(code),
  write: (line) => process.stderr.write(line),
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(signal, () => { void shutdown(signal); });
  } catch {
    // Not every signal exists on every platform; the ones that do are enough.
  }
}

// createReaper rather than an object literal here. This line WAS a literal, wired with
// `remove: () => {}`, so the sweep ran every thirty seconds, classified correctly, and reaped nothing.
// A unit test of the sweep could not see it, because the sweep was never wrong. See lib/reaper.mjs.
const reaper = createReaper(runner);

/** What the last sweep could not answer for. Surfaced through /health so it is never a silent leak. */
let unknown = [];

/**
 * This environment's own io. The only traffic it can honestly report: it has no visibility into what a
 * service does elsewhere, and a number here that meant anything wider would be invented.
 */
const traffic = { requests: 0, bytesOut: 0 };

const server = createServer(async (request, response) => {
  traffic.requests += 1;

  // BEFORE THE BODY IS READ, and before anything is dispatched. A page the operator merely visits can
  // reach this loopback port; binding 127.0.0.1 keeps the network out but not the browser, which is
  // already on the machine. See lib/browser-requests.mjs for the request shape that needs no
  // preflight. Refused here rather than in `handleRequest` because it is a property of the TRANSPORT,
  // not of any route, and a route added later must inherit it without anyone remembering to ask.
  const browser = browserOriginatedRequest({ method: request.method, headers: request.headers });
  if (browser.refuse) {
    process.stderr.write(`[aify-env] ${browser.reason}${chr10}`);
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: browser.reason }));
    return;
  }

  let body = null;
  if (request.method === "POST" || request.method === "PUT") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      body = undefined;
    }
  }

  let result;
  try {
    result = await handleRequest(
      { method: request.method, path: new URL(request.url, "http://localhost").pathname, body },
      {
        runner,
        readFile: (path) => readFileSync(path, "utf8"),
        version: VERSION,
        build: BUILD,
        unknown,
        terminals: terminalSupport(),
        advertising: advertisingHealthNow().advertising,
        advertisingTo: advertisingHealthNow().services,
        traffic,
      },
    );
  } catch (failure) {
    // An unexpected throw must not leave a caller hanging, and must not leak a stack to it either.
    process.stderr.write(`[aify-env] unhandled: ${failure.stack ?? failure}\n`);
    result = { status: 500, body: { error: "internal error" } };
  }

  // A stream, not an answer. Server-sent events because a console only ever reads: no framing to get
  // wrong, no upgrade handshake, and it reconnects by itself when a viewer's tab wakes up.
  if (result.stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const unsubscribe = runner.subscribe(
      result.stream,
      (chunk) => {
        // One SSE event per chunk, JSON-encoded so a newline in the output cannot end the event
        // early - which it would, because a newline is the frame delimiter in this protocol.
        response.write("data: " + JSON.stringify(chunk) + FRAME_END);
        traffic.bytesOut += Buffer.byteLength(chunk);
      },
      (code, signal) => {
        // A NAMED event, so a consumer reading data: frames as output cannot mistake an exit for a
        // line the process printed. Then the stream ends: a console told the process is gone has
        // nothing left to wait for, and leaving it open makes a dead agent look like a thinking one
        // -- which is the failure this event exists to prevent.
        //
        // TWO FIELDS SINCE 2026-08-26, because one could not say what happened. `code` may now be
        // null -- that is what a signalled death looks like, and it used to be coerced to 0 before it
        // ever reached this line. `signal` is OMITTED rather than sent empty, so a consumer can tell
        // "nothing killed it" from "killed by something I have no name for", and so an older consumer
        // reading only `code` sees a frame the same shape it always saw.
        const frame = signal ? { code, signal } : { code };
        response.write("event: exit" + chr10 + "data: " + JSON.stringify(frame) + FRAME_END);
        response.end();
      },
    );
    if (!unsubscribe) {
      // Raced: the process went between the route check and here.
      response.end();
      return;
    }
    // A viewer closing its tab must release the subscription, or every visit leaks one.
    request.on("close", () => unsubscribe());
    return;
  }

  if (result.body === null) {
    response.writeHead(result.status);
    response.end();
    return;
  }
  const payload = JSON.stringify(result.body);
  traffic.bytesOut += Buffer.byteLength(payload);
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(payload);
});

// A PORT ALREADY IN USE IS AN ORDINARY CONDITION, so it gets an ordinary message.
//
// Without this the process died on an unhandled 'error' event and printed a Node stack trace, for the
// most likely mistake anyone makes with this command: running it twice. The remedy is obvious once
// stated and invisible in a trace, and an operator meeting that dump has no reason to think an
// environment is already up and serving perfectly well.
//
// Exit 69 (EX_UNAVAILABLE) rather than 1: a supervisor restarting on failure should not fight the
// instance that already holds the port.
/** Whether the thing holding our port is an aify-env, and which pid it is. */
async function incumbent() {
  try {
    const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    // Both, because either alone is weak: a pid says nothing about what the process is, and a healthy
    // status could come from anything that serves JSON on this port.
    if (body?.status === "healthy" && Number.isInteger(body?.pid)) return { pid: body.pid, version: body.version };
    return null;
  } catch {
    return null;
  }
}

let superseding = false;
server.on("error", async (failure) => {
  if (failure?.code === "EADDRINUSE") {
    // TAKE OVER, rather than refuse. Operator ruling: starting the environment means this one serves.
    // The predecessor's processes are not abandoned -- they are in the record, and this instance reaps
    // from it after the port is ours, which is precisely why the reap moved.
    //
    // Only after ASKING. Killing whatever holds a port is how you end somebody else's server, so a
    // holder that does not identify as an aify-env is left alone and reported.
    if (superseding) {
      process.stderr.write(`aify-env: could not take http://${HOST}:${port} even after stopping the previous instance.${chr10}`);
      process.exit(69);
    }
    const holder = await incumbent();
    if (!holder) {
      process.stderr.write(
        `aify-env: ${HOST}:${port} is held by something that is not an aify-env.${chr10}`
        + `  It has been left alone. Free the port, or run with --port <n>.${chr10}`,
      );
      process.exit(69);
    }
    superseding = true;
    process.stderr.write(
      `aify-env: superseding the environment already running on ${HOST}:${port} (pid ${holder.pid}, `
      + `version ${holder.version ?? "unknown"}).${chr10}`,
    );
    try {
      await killTree(holder.pid);
    } catch {
      // Reported by the retry failing, rather than swallowed here where it would read as success.
    }
    // Give the socket time to be released before trying again. A tighter loop just spends the same
    // wait in more attempts.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!(await incumbent())) break;
    }
    server.listen(port, HOST);
    return;
  }
  if (failure?.code === "EACCES") {
    process.stderr.write(`aify-env: not allowed to listen on ${HOST}:${port}.${chr10}`);
    process.exit(77);
  }
  // Anything else is genuinely unexpected and keeps its detail, which is what a trace is FOR.
  process.stderr.write(`aify-env: could not listen on ${HOST}:${port}: ${failure?.stack ?? failure}${chr10}`);
  process.exit(70);
});

server.listen(port, HOST, async () => {
  const bound = server.address();
  const support = terminalSupport();
  // THE PORT IS OURS, so anything left in the record is genuinely an orphan. Not before: see
  // reapLeftovers.
  await reapLeftovers();
  // One write, so the banner arrives whole. Two writes is a race for anything reading startup output
  // to know the process is up — including the tests, which caught exactly that.
  process.stdout.write(
    `aify-env ${VERSION} listening on http://${HOST}:${bound.port}\n`
    // Said at startup rather than discovered when a console renders nothing.
    + (support.available
      // The backend is named only when it is the NON-default one, so a normal boot is unchanged and an
      // operator running the conpty-DLL experiment can see at a glance that their variable took.
      ? `terminals: available${support.conptyDll ? " (conpty DLL backend, AIFY_ENV_CONPTY_DLL=1)" : ""}\n`
      : `terminals: UNAVAILABLE (${support.reason}) — processes will run with piped stdio\n`),
  );

  // THE TERMINAL THAT STARTS THE ENVIRONMENT SHOWS WHAT IT IS DOING. Operator request, 2026-08-24:
  // running `aify-env` should open the view, not print two lines and go quiet.
  //
  // Only when stdout is a TTY. Piped or redirected -- a service manager, a log file, a test capturing
  // startup -- keeps the plain banner, because screen-clearing escapes in a log are noise nobody asked
  // for and that banner is what those readers parse.
  //
  // The view owns no lifecycle: `stop` is called from the shutdown path, so an interrupt still means
  // "take the managed processes with you" rather than being pre-empted by a handler belonging to a
  // screen. Two exit paths racing is the defect this repo just removed.
  if (process.stdout.isTTY && !NO_DASHBOARD) {
    try {
      const view = await startDashboard({
        endpoint: `http://${HOST}:${bound.port}`,
        registryPath: join(homedir(), ".aify", "services.json"),
        intervalMs: Number(process.env.AIFY_TUI_REFRESH_MS || 2000),
        // Decided HERE, where the screen is, and passed to a pure renderer. NO_COLOR is the
        // convention every other tool honours and costs one condition to respect.
        columns: process.stdout.columns || 100,
        color: !process.env.NO_COLOR,
      });
      stopDashboard = view.stop;
    } catch (failure) {
      // A view that cannot draw must never stop the environment from serving. It is the decoration;
      // the daemon is the product.
      process.stderr.write(`[aify-env] dashboard unavailable: ${failure.message}${chr10}`);
    }
  }
});

const SWEEP_MS = Number(process.env.AIFY_SWEEP_MS || 30_000);
const sweepTimer = setInterval(() => {
  unknown = reaper.sweep().unknown;
}, SWEEP_MS);
sweepTimer.unref();

// ── telling every registered service what this host can do ───────────────────────────────────────
//
// ON BY DEFAULT, and the collision it used to risk is closed rather than avoided. `runtimes` and
// `terminalRuntimes` are last-writer-wins, so two advertisers computing them differently would flap
// the row -- which reads like failing hardware rather than like two components disagreeing. The
// bridge now asks this daemon's `/health` whether it is advertising and omits host facts when it is,
// so exactly one tier describes a host. `AIFY_ADVERTISE=0` hands the job back to the bridge.
//
// STANDING DOWN IS SAFE because a heartbeat that omits a field no longer erases it: see aify-comms
// `service/api_core/environment_registration.py`, which preserves what a caller did not mention.
//
// The timer is `unref`'d exactly like the sweep above: a daemon whose last outstanding work is a
// heartbeat should still be able to exit.

const ADVERTISE = advertisingEnabled(process.env.AIFY_ADVERTISE);
const ADVERTISE_MS = Number(process.env.AIFY_ADVERTISE_MS || 30_000);
const REDETECT_MS = Number(process.env.AIFY_ADVERTISE_REDETECT_MS || 300_000);
const REGISTRY_FILE = process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json");

/**
 * Where the wrappers live: every PATH entry, which is where a launcher has to be to be launchable.
 *
 * Reading a directory is not running anything in it. Deciding what a launcher is by ASKING it would
 * start a coding-agent runtime -- a pre-contract wrapper forwards `--check` to the runtime -- which
 * is how a fleet went down once already.
 */
function launcherCandidates() {
  const separator = process.platform === "win32" ? ";" : ":";
  const entries = [];
  const seen = new Set();
  for (const dir of String(process.env.PATH || "").split(separator).map((d) => d.trim()).filter(Boolean)) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      // One unreadable directory must not make the rest of PATH unsearchable.
      continue;
    }
    for (const name of names) {
      const file = `${dir}/${name}`;
      if (seen.has(file)) continue;
      seen.add(file);
      // Only files whose NAME could be a launcher are read. The marker is still what decides, but
      // reading every executable on PATH to find out would be a great deal of I/O for one answer.
      if (!name.includes("-aify")) continue;
      try {
        entries.push({ file, text: readFileSync(file, "utf8") });
      } catch {
        // FAILS CLOSED: unread is absent, never present.
      }
    }
  }
  return entries;
}

/**
 * POST one advertisement. Injected into `advertiseTo`, which is otherwise pure.
 *
 * The key is an ARGUMENT, resolved by `credentialFor` from the names the registry declares. It sent
 * none at all until 2026-08-30, so turning `API_KEY` on 401'd every advertisement -- and the daemon
 * reported `advertising: true` through all of it while the bridge stood down. `X-API-Key` is the
 * header the service accepts (`service/main.py`); an empty key sends no header rather than an empty
 * one, because a blank credential is a 401 with a more confusing cause.
 */
async function postAdvertisement(url, body, apiKey = "") {
  const headers = { "content-type": "application/json" };
  if (String(apiKey || "").trim() !== "") headers["X-API-Key"] = String(apiKey).trim();
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

let lastDetectedAt = 0;
let detectedRuntimes = [];
let lastFingerprint = "";
//: What /health reports, refreshed by each beat. Read from the SAME resolution the beat uses, so the
//: answer cannot say "somebody is being told" while the beat posts to nobody -- which is the one
//: wrong answer that strands a host, because the bridge stands down on it.
let advertisingTargets = [];
//: Target url -> epoch ms of the last beat that came back 2xx. THE ONLY EVIDENCE that a service is
//: actually being described by this daemon. Reporting "advertising" from the target LIST instead
//: meant a 401 counted as success, and the aify-comms bridge stands down on that answer.
const acceptedBeats = new Map();

function advertisingHealthNow() {
  return advertisementHealth({
    enabled: ADVERTISE,
    targets: advertisingTargets,
    acceptedAt: acceptedBeats,
    now: Date.now(),
    staleMs: advertisementStaleMs(ADVERTISE_MS),
  });
}

async function advertiseOnce() {
  let registryText = "";
  try {
    registryText = readFileSync(REGISTRY_FILE, "utf8");
  } catch {
    // No registry means nobody has asked to be told. Not an error -- but it IS "not advertising",
    // and saying otherwise would make the bridge stand down for a host nobody is describing.
    advertisingTargets = [];
    return;
  }
  const targets = advertisementTargets(readServices(registryText));
  advertisingTargets = targets;
  if (targets.length === 0) return;

  const now = Date.now();
  if (shouldRedetect({ lastDetectedAt, now, intervalMs: REDETECT_MS })) {
    detectedRuntimes = runtimeAvailability(installedHarnesses(launcherCandidates()));
    lastDetectedAt = now;
  }

  const support = terminalSupport();
  const kind = environmentKind({ platform: process.platform, env: process.env, exists: existsSync });
  const body = environmentAdvertisement({
    hostname: hostname(),
    kind,
    os: environmentOs(process.platform),
    machineId: machineIdFor({
      platform: process.platform,
      hostname: hostname(),
      env: process.env,
      isWsl: kind === "wsl",
    }),
    // NO `cwdRoots`. Which directories work may run in is the service's policy, and an advertiser
    // sending an empty list would erase what the operator configured. Omitted means "kept".
    runtimes: detectedRuntimes,
    terminal: support.available,
    terminalReason: support.reason,
    version: VERSION,
    instance: BUILD,
  });

  // WHAT CHANGED, said once rather than every beat. The fingerprint covers exactly the fields a
  // re-walk could move, so a line here means a harness was installed or disappeared -- which is the
  // event an operator is watching for, and it is invisible in a stream of identical heartbeats.
  const fingerprint = capabilityFingerprint(body);
  if (lastFingerprint !== "" && fingerprint !== lastFingerprint) {
    process.stderr.write(
      `[aify-env] capabilities changed: ${body.terminalRuntimes.join(", ") || "none"}${chr10}`,
    );
  }
  lastFingerprint = fingerprint;

  // Reported, never thrown: a service being down is that service's news, not this daemon's failure.
  const results = await advertiseTo({ targets, body, post: postAdvertisement, env: process.env });
  for (const result of results) {
    if (result.ok) {
      // Only a 2xx counts. This is the whole fix: acceptance is recorded, refusal is not.
      acceptedBeats.set(result.url, Date.now());
      continue;
    }
    // Reported, never thrown: a service being down is that service's news, not this daemon's
    // failure. It is also NOT recorded as an acceptance, so that service's bridge keeps the job.
    process.stderr.write(
      `[aify-env] advertisement to ${result.url} failed (${result.status || result.error})${chr10}`,
    );
  }
}

if (ADVERTISE) {
  void advertiseOnce();
  const advertiseTimer = setInterval(() => { void advertiseOnce(); }, ADVERTISE_MS);
  advertiseTimer.unref();
}
