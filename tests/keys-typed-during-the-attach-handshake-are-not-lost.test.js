#!/usr/bin/env node
// Nothing typed while `aify-env attach` is starting may be thrown away.
//
// EXTERNAL REVIEW, 2026-09-21, finding A. The client called `process.stdin.resume()` and THEN awaited
// the socket handshake, attaching its data listener afterwards -- and a resumed stdin with no
// listener discards what arrives. The window is a millisecond on a healthy host and up to the 400 ms
// connect timeout against a busy daemon, which is the same load that produced the scrambling this
// transport work started from. Ctrl-] was dropped in that window too.
//
// IT DRIVES THE REAL CLI against a fake daemon, because the defect was in the ORDER of three
// statements in that file: a unit test of any module here would have passed while the bug shipped.
// The daemon answers /health slowly on purpose, so the key is typed before the client is listening,
// and the connect is held open by a preload (fixtures/input-socket-connect-never-completes.mjs),
// because on Linux a failed unix-socket connect leaves no window at all.

import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "aify-env-attach.mjs");
const HOLD_CONNECT = pathToFileURL(path.join(HERE, "fixtures", "input-socket-connect-never-completes.mjs")).href;

/** An address of the right shape for this platform that nothing is listening on. */
const unreachableSocket = process.platform === "win32"
  ? `${String.fromCharCode(92, 92, 46, 92)}pipe${String.fromCharCode(92)}aify-env-not-there-${process.pid}`
  : path.join(process.env.TMPDIR || "/tmp", `aify-env-not-there-${process.pid}.sock`);

/** A daemon that is slow to answer /health and records what is typed at it. */
function slowDaemon({ healthDelayMs }) {
  const received = [];
  const server = http.createServer((request, response) => {
    const body = [];
    request.on("data", (chunk) => body.push(chunk));
    request.on("end", () => {
      const url = request.url || "";
      if (url === "/health") {
        // AN ADDRESS NOBODY ANSWERS, which is what makes this test able to fail. The window is the
        // AWAIT on the socket handshake, so a daemon offering no socket has no window at all -- the
        // first version of this test set AIFY_ENV_LOCAL_SOCKET=0 and passed against the bug. Here the
        // client tries, waits out its 400 ms connect timeout, and falls back to HTTP.
        setTimeout(() => { response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "healthy", inputSocket: unreachableSocket })); }, healthDelayMs);
        return;
      }
      if (url === "/processes") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ processes: [{ id: "p1", label: "lead", terminal: true }] }));
        return;
      }
      if (url.endsWith("/input")) {
        try { received.push(JSON.parse(Buffer.concat(body).toString("utf8")).data); } catch { /* not ours */ }
        response.writeHead(204); response.end();
        return;
      }
      if (url.endsWith("/resize")) { response.writeHead(204); response.end(); return; }
      if (url.endsWith("/output")) {
        // An SSE stream that says nothing: the client stays attached instead of exiting.
        response.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      response.writeHead(404); response.end("{}");
    });
  });
  return { server, received };
}

test("a key typed before the handshake finishes still reaches the daemon", async (t) => {
  const daemon = slowDaemon({ healthDelayMs: 300 });
  await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${daemon.server.address().port}`;

  // A REAL TERMINAL ON BOTH ENDS, because the client refuses anything else -- and rightly: without
  // raw mode every keystroke is line buffered and Ctrl-C never reaches the program. A piped spawn
  // exits 64 before any of this can be observed, which is how the defect stayed invisible.
  const pty = createRequire(import.meta.url)("node-pty");
  const child = pty.spawn(process.execPath, ["--import", HOLD_CONNECT, CLI, "--id", "p1"], {
    name: "xterm-color", cols: 80, rows: 24,
    env: { ...process.env, AIFY_ENV_ENDPOINT: endpoint, AIFY_ENV_LOCAL_SOCKET: "1" },
  });
  t.after(async () => {
    try { child.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => daemon.server.close(resolve));
  });
  child.onData(() => {});

  // TYPED IMMEDIATELY, while /health is still being answered. This is the window that used to eat it.
  child.write("early");

  const arrived = await (async () => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (daemon.received.join("").includes("early")) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  })();

  assert.ok(arrived, `the daemon never received it; it got ${JSON.stringify(daemon.received)}`);
});
