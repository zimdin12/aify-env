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
//   aify-env                 run in the foreground on 127.0.0.1:8802
//   aify-env doctor          what this host can say about itself, and what each service said
//   aify-env tui             the same, live
//   aify-env --port 0        pick an ephemeral port (used by tests)
//   aify-env --version
//
// ONE command on PATH, with subcommands. Three sibling binaries is what collided with aify-comms'
// own `aify-doctor`; a collision is only the loud version of the problem.
//
// There is deliberately no `--host`.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest } from "../lib/protocol.mjs";
import { createReaper } from "../lib/reaper.mjs";
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

// REAP BEFORE LISTENING. Anything in the record is by definition from an instance that is no longer
// running -- this one has not started a process yet -- so a live pid there is an orphan.
//
// The killing decision fails CLOSED: a pid that cannot be confirmed as ours is left alone and
// reported. Pid reuse is real, and ending a stranger's process is a worse failure than the leak.
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

const runner = new Runner({ ownedFile: OWNED_FILE });

// AND DIE TOGETHER. The handlers cover the graceful exits; the record above covers the hard kill that
// runs no handler at all. Both halves are needed: without the handlers a clean Ctrl-C would leak until
// the next start, and without the record nothing survives a SIGKILL.
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[aify-env] ${signal}: stopping ${runner.list().length} managed process(es)${chr10}`);
  Promise.allSettled(runner.list().map((p) => runner.stop(p.id)))
    .then(() => {
      clearOwned(OWNED_FILE);
      process.exit(0);
    });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(signal, () => shutdown(signal));
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
      (code) => {
        // A NAMED event, so a consumer reading data: frames as output cannot mistake an exit for a
        // line the process printed. Then the stream ends: a console told the process is gone has
        // nothing left to wait for, and leaving it open makes a dead agent look like a thinking one
        // -- which is the failure this event exists to prevent.
        response.write("event: exit" + chr10 + "data: " + JSON.stringify({ code }) + FRAME_END);
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

server.listen(port, HOST, () => {
  const bound = server.address();
  const support = terminalSupport();
  // One write, so the banner arrives whole. Two writes is a race for anything reading startup output
  // to know the process is up — including the tests, which caught exactly that.
  process.stdout.write(
    `aify-env ${VERSION} listening on http://${HOST}:${bound.port}\n`
    // Said at startup rather than discovered when a console renders nothing.
    + (support.available
      ? "terminals: available\n"
      : `terminals: UNAVAILABLE (${support.reason}) — processes will run with piped stdio\n`),
  );
});

const SWEEP_MS = Number(process.env.AIFY_SWEEP_MS || 30_000);
const sweepTimer = setInterval(() => {
  unknown = reaper.sweep().unknown;
}, SWEEP_MS);
sweepTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Stop accepting first, then let the loop drain. Processes we own keep running: this environment
    // going down is not a reason to kill somebody else's agent, and a new one adopts nothing it cannot
    // see, which is a Phase 8 subject rather than a reason to reap here.
    server.close(() => process.exit(0));
  });
}
