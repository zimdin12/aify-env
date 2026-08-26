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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest } from "../lib/protocol.mjs";
import { createReaper } from "../lib/reaper.mjs";
import { createShutdown } from "../lib/shutdown.mjs";
import { startDashboard } from "../lib/dashboard.mjs";
import { Runner, terminalSupport } from "../lib/runner.mjs";
import { clearOwned, readOwned } from "../lib/owned-processes.mjs";
import { defaultVerify, planOrphanReap } from "../lib/orphan-reap.mjs";
import { killTree } from "../lib/kill-tree.mjs";
import { defaultIsAlive } from "../lib/reaper.mjs";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

/** Never configurable. See above. */
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8802;

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`aify-env ${VERSION}\n`);
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
function reapLeftovers() {
  const leftovers = planOrphanReap(readOwned(OWNED_FILE), { isAlive: defaultIsAlive, verify: defaultVerify });
  for (const entry of leftovers.reap) {
    // The TREE, not the pid: the recorded process is a launcher, and the agent it started is a child of
    // it. Reaping only the launcher leaves exactly the process an operator cared about.
    const killed = killTree(entry.pid);
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
  clearOwned(OWNED_FILE);
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
  clearOwned: () => clearOwned(OWNED_FILE),
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
        unknown,
        terminals: terminalSupport(),
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
      killTree(holder.pid);
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
  reapLeftovers();
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
