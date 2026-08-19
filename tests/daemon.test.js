#!/usr/bin/env node
// The daemon, over a real socket.
//
// Everything it decides is unit-tested in protocol.test.js. What is only reachable here is that it
// binds where it says it binds and speaks the shape it says it speaks — and the binding is the one
// that matters, because this process starts programs on request. Reachable from another machine it is
// a remote shell with a JSON interface.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

test("END TO END: a real launcher starts, is owned, and is forgotten when it exits", async () => {
  // The phase gate in one test. Everything else here checks a rule; this checks that the rules add up
  // to a process actually running on this machine, started the way a service would start it.
  const { child, base } = await startDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-launcher-"));
  const launcher = path.join(dir, "fake-aify");
  fs.writeFileSync(launcher, [
    "#!/bin/bash",
    'HARNESS_WRAPPER_VERSION="0.6.0"',
    'echo "launcher-ran"',
    "sleep 1",
    "exit 0",
    "",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(launcher, 0o755);

  try {
    const started = await fetch(`${base}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "aify-comms", launcher: launcher.split(String.fromCharCode(92)).join("/") }),
      signal: AbortSignal.timeout(10_000),
    });
    // Read the body ONCE: a failed assertion that consumes it leaves nothing to parse afterwards.
    const startedText = await started.text();
    assert.equal(started.status, 201, startedText);
    const handle = JSON.parse(startedText);
    assert.ok(handle.pid > 0, "no pid came back");
    assert.equal(handle.service, "aify-comms");
    assert.equal(typeof handle.terminal, "boolean", "the answer must say which path it got");

    // Owned while it runs.
    const during = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(during.processes.length, 1, "a running process was not owned");
    assert.equal(during.processes[0].service, "aify-comms");

    // Forgotten when it exits, without anyone calling stop().
    const deadline = Date.now() + 15_000;
    let after = during;
    while (after.processes.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).json();
    }
    assert.equal(after.processes.length, 0, "an exited process is still owned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await stop(child);
  }
});
