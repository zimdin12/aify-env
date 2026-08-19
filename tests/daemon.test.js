#!/usr/bin/env node
// The daemon, over a real socket.
//
// Everything it decides is unit-tested in protocol.test.js. What is only reachable here is that it
// binds where it says it binds and speaks the shape it says it speaks — and the binding is the one
// that matters, because this process starts programs on request. Reachable from another machine it is
// a remote shell with a JSON interface.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs");

/** Start on an ephemeral port and resolve once it says where it landed. */
function startDaemon() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`daemon did not start:\n${output}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ child, base: match[1], output: () => output });
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
  });
}

const stop = (child) => new Promise((resolve) => {
  child.on("exit", resolve);
  child.kill();
});

test("it binds LOOPBACK, and announces the address it actually got", async () => {
  const { child, base } = await startDaemon();
  try {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "bound somewhere other than loopback");
  } finally {
    await stop(child);
  }
});

test("GET /health answers with this environment's own report", async () => {
  const { child, base } = await startDaemon();
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "healthy");
    assert.ok(Array.isArray(body.processes));
    assert.equal(body.processes.length, 0, "a fresh environment owns nothing");
  } finally {
    await stop(child);
  }
});

test("a launcher without the marker is REFUSED over the wire, with a reason", async () => {
  // The guard, reached the way a service would reach it rather than by calling the predicate.
  const { child, base } = await startDaemon();
  try {
    const response = await fetch(`${base}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "aify-comms", launcher: DAEMON }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /marker/i);
  } finally {
    await stop(child);
  }
});

test("an unknown route is 404 rather than anything happening", async () => {
  const { child, base } = await startDaemon();
  try {
    const response = await fetch(`${base}/whatever`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 404);
  } finally {
    await stop(child);
  }
});

test("malformed JSON is a 400, not a crash", async () => {
  const { child, base } = await startDaemon();
  try {
    const response = await fetch(`${base}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 400);
    // And it must still be serving afterwards.
    assert.equal((await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
  } finally {
    await stop(child);
  }
});

test("it SAYS whether terminals are available, at startup", async () => {
  // Rather than leaving it to be discovered when a console renders nothing.
  const { child, output } = await startDaemon();
  try {
    assert.match(output(), /terminals: (available|UNAVAILABLE)/);
  } finally {
    await stop(child);
  }
});
