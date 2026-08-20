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
function startDaemon(env = {}) {
  return new Promise((resolve, reject) => {
    // SEALED: the daemon records what it owns, and reaps from that record at startup. Pointed at the
    // real ~/.aify path a test would read the operator's live state and could KILL a process it never
    // started. A temp file per daemon keeps the test's blast radius inside the test.
    const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-env-rec-")), "owned.json");
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      // Order matters: the seal must beat an ambient AIFY_ENV_PROCESS_RECORD, while a test that
      // deliberately sets one still wins.
      env: { ...process.env, AIFY_ENV_PROCESS_RECORD: record, ...env },
    });
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

test("STREAM: a service can watch a process's output over the wire", async () => {
  // The piece Phase 8 was blocked on. Start, stop and list are request/response; a console is not, and
  // a delegated spawn without this would carry the process and lose the terminal.
  const { child, base } = await startDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-stream-"));
  const launcher = path.join(dir, "chatty-aify");
  fs.writeFileSync(launcher, [
    "#!/bin/bash",
    'HARNESS_WRAPPER_VERSION="0.6.0"',
    'echo "FIRST-LINE"',
    "sleep 1",
    'echo "SECOND-LINE"',
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
    const startedText = await started.text();
    assert.equal(started.status, 201, startedText);
    const handle = JSON.parse(startedText);

    // Attach LATE on purpose: the first line has probably already been printed, and a console that
    // only shows what happened after somebody looked is a console that shows an empty pane.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const controller = new AbortController();
    const stream = await fetch(`${base}/processes/${handle.id}/output`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);

    let seen = "";
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.includes("SECOND-LINE")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    controller.abort();

    assert.match(seen, /FIRST-LINE/, "the replay did not carry what was printed before attaching");
    assert.match(seen, /SECOND-LINE/, "live output did not arrive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await stop(child);
  }
});

test("STREAM: watching a process that does not exist is a 404", async () => {
  // Distinct from an open-but-quiet stream. One means look elsewhere; the other means wait.
  const { child, base } = await startDaemon();
  try {
    const res = await fetch(`${base}/processes/never-existed/output`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 404);
  } finally {
    await stop(child);
  }
});

test("the daemon's SWEEP actually runs, and does not disturb a healthy environment", async () => {
  // Until now the sweep had never executed in the daemon at all: the interval is thirty seconds and
  // every test kills the daemon long before that. So the one place it is wired was the one place it
  // was never exercised -- which is exactly where it was wired to a no-op.
  //
  // The reaper is a BACKSTOP: its trigger, a process that died without its exit being observed, cannot
  // be produced through the API, because the close handler always fires first. So what is proven here
  // is that the sweep runs repeatedly in the daemon without error and leaves a healthy environment
  // alone. That it removes the right things is proven in reaper-wiring.test.js, against the same
  // wiring this daemon now uses.
  const { child, base, output } = await startDaemon({ AIFY_SWEEP_MS: "120" });
  try {
    // Long enough for several sweeps.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(health.status, "healthy", "the environment did not survive its own sweeps");
    assert.deepEqual(health.unknown, [], "an idle environment reported unanswerable processes");
    assert.doesNotMatch(output(), /unhandled/i, `the sweep raised something:
${output()}`);
  } finally {
    await stop(child);
  }
});
