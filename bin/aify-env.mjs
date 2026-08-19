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
//   aify-env                 run in the foreground on 127.0.0.1:8801
//   aify-env --port 0        pick an ephemeral port (used by tests)
//   aify-env --version
//
// There is deliberately no `--host`.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest } from "../lib/protocol.mjs";
import { Reaper } from "../lib/reaper.mjs";
import { Runner, terminalSupport } from "../lib/runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

/** Never configurable. See above. */
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8801;

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`aify-env ${VERSION}\n`);
  process.exit(0);
}
const portFlag = args.indexOf("--port");
const port = portFlag === -1 ? DEFAULT_PORT : Number(args[portFlag + 1]);

const runner = new Runner();
const reaper = new Reaper({ registry: { list: () => runner.list(), remove: () => {} } });

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

const sweepTimer = setInterval(() => {
  unknown = reaper.sweep().unknown;
}, 30_000);
sweepTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Stop accepting first, then let the loop drain. Processes we own keep running: this environment
    // going down is not a reason to kill somebody else's agent, and a new one adopts nothing it cannot
    // see, which is a Phase 8 subject rather than a reason to reap here.
    server.close(() => process.exit(0));
  });
}
