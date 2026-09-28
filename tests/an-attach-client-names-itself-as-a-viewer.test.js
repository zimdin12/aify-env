#!/usr/bin/env node
// `aify-env attach` names itself on every keystroke and resize, on both transports, and each client
// names itself differently.
//
// WHAT IT PROTECTS. The terminal gives its size back to a viewer that types (terminal-size-owner.mjs),
// which works only if the daemon can tell viewers apart. A client that sent no name would never get its
// size back; two Herdr panes sharing one name would be one viewer, so typing in the smaller pane after
// the larger one resized would change nothing.
//
// THE REAL CLIENT, in a real terminal: it refuses to run without raw mode.

import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { InputSocketServer, localSocketAddress } from "../lib/input-socket.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env-attach.mjs");
const VIEWER = /^attach:[0-9a-f]{8}$/;

/** A daemon that records the body of every input and resize, from HTTP and from its socket alike. */
async function recordingDaemon({ withSocket }) {
  const seen = [];
  const socket = withSocket
    ? await new InputSocketServer({
      address: localSocketAddress({ port: `viewer-${process.pid}`, dir: os.tmpdir() }),
      handleRequest: async (request) => { seen.push({ via: "socket", path: request.path, body: request.body }); return { status: 204, body: null }; },
      deps: () => ({}),
    }).start()
    : null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url || "";
      const json = (body) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (url === "/health") return json({ status: "healthy", ...(socket ? { inputSocket: socket.address } : {}) });
      if (url === "/processes") return json({ processes: [{ id: "p1", label: "lead", terminal: true }] });
      if (url.endsWith("/input") || url.endsWith("/resize")) {
        try { seen.push({ via: "http", path: url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { /* not ours */ }
        response.writeHead(204); response.end();
        return undefined;
      }
      if (url.endsWith("/output")) { response.writeHead(200, { "content-type": "text/event-stream" }); return undefined; }
      response.writeHead(404); response.end("{}");
      return undefined;
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    // The /output stream never ends on its own, so it is cut rather than waited for.
    close: async () => { await socket?.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

function attach(t, endpoint, localSocket) {
  const pty = createRequire(import.meta.url)("node-pty");
  const child = pty.spawn(process.execPath, [CLI, "--id", "p1"], {
    name: "xterm-color", cols: 80, rows: 24,
    env: { ...process.env, AIFY_ENV_ENDPOINT: endpoint, AIFY_ENV_LOCAL_SOCKET: localSocket },
  });
  child.onData(() => {});
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  return child;
}

async function until(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Each client's viewer on its resize and on its keystroke, keyed by the key it typed. */
async function viewersOf(daemon, children, via) {
  const typed = (key) => daemon.seen.find((s) => s.via === via && s.path.endsWith("/input") && s.body.data === key);
  for (const [key, child] of children) {
    // Typed repeatedly until it lands: a key typed before the socket connects travels by HTTP.
    await until(() => { if (!typed(key)) child.write(key); return Boolean(typed(key)); });
  }
  return children.map(([key]) => typed(key)?.body.viewer);
}

test("over HTTP: resize and keystroke carry one viewer, and two clients carry two", async (t) => {
  const daemon = await recordingDaemon({ withSocket: false });
  t.after(daemon.close);
  const children = [["a", attach(t, daemon.endpoint, "0")], ["b", attach(t, daemon.endpoint, "0")]];

  const [a, b] = await viewersOf(daemon, children, "http");
  assert.match(String(a), VIEWER, `a keystroke carried ${a}`);
  assert.match(String(b), VIEWER, `a keystroke carried ${b}`);
  assert.notEqual(a, b, "two clients named themselves the same, so the daemon sees one viewer");
  const resizers = daemon.seen.filter((s) => s.path.endsWith("/resize")).map((s) => s.body.viewer);
  assert.deepEqual([...new Set(resizers)].sort(), [a, b].sort(), "each client's resize carries the name its keys do");
});

test("over the local socket: the keystroke carries the viewer too", async (t) => {
  const daemon = await recordingDaemon({ withSocket: true });
  t.after(daemon.close);
  const child = attach(t, daemon.endpoint, "1");
  // CONTROL: the key must have travelled by the socket, or this test is the HTTP one again.
  const [viaSocket] = await viewersOf(daemon, [["s", child]], "socket");
  assert.match(String(viaSocket), VIEWER, `a keystroke over the socket carried ${viaSocket}`);
});
