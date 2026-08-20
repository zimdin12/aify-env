#!/usr/bin/env node
// The view, against a real environment with a real process in it.
//
// tui.test.js proves the renderer: given a snapshot, these lines. What it cannot prove is that the
// snapshot is ever assembled correctly from a live daemon — and a view that renders a perfect empty
// frame is exactly as useless as one that renders nothing.
//
// Same rule as the doctor: every other test here has only ever seen the view with nothing running. A
// component observed only in its empty state has not been observed.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "..", "bin", "aify-env.mjs");
const TUI = path.join(HERE, "..", "bin", "aify-env-tui.mjs");

function startDaemon() {
  return new Promise((resolve, reject) => {
    // SEALED, like daemon.test.js: the daemon records what it owns and REAPS from that record at
    // startup. Pointed at the real ~/.aify path, a test could kill a process it never started.
    const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-env-rec-")), "owned.json");
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AIFY_ENV_PROCESS_RECORD: record },
    });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`daemon did not start:\n${output}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ child, base: match[1] });
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
  });
}

const stopDaemon = (child) => new Promise((resolve) => {
  child.on("exit", resolve);
  child.kill();
});

const frame = (endpoint, registry) => spawnSync(process.execPath, [TUI, "--once"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { ...process.env, AIFY_ENV_ENDPOINT: endpoint, AIFY_SERVICE_REGISTRY: registry, AIFY_PROBE_TIMEOUT_MS: "1000" },
});

test("BOTH DIRECTIONS: the view shows a live environment, and says so when there is none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-live-"));
  const registry = path.join(dir, "services.json");
  const { child, base } = await startDaemon();

  try {
    const alive = frame(base, registry);
    assert.equal(alive.status, 0, alive.stderr);
    assert.match(alive.stdout, /127\.0\.0\.1/);
    assert.doesNotMatch(alive.stdout, /not answering/, "a live environment was rendered as absent");
  } finally {
    await stopDaemon(child);
  }

  // Same endpoint, nothing on it. If the view rendered identically either way it would be decoration.
  const dead = frame(base, registry);
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(dead.stdout, /not answering/, "a dead environment was rendered as live");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a process started through the daemon APPEARS in the view", async () => {
  // The claim the whole component makes. Rendering a correct empty frame proves the renderer and
  // nothing about the snapshot ever being filled in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-live-"));
  const registry = path.join(dir, "services.json");
  const launcher = path.join(dir, "slow-aify");
  fs.writeFileSync(launcher, [
    "#!/bin/bash",
    'HARNESS_WRAPPER_VERSION="0.6.0"',
    "sleep 5",
    "",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(launcher, 0o755);

  const { child, base } = await startDaemon();
  try {
    const started = await fetch(`${base}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "aify-comms",
        launcher: launcher.split(String.fromCharCode(92)).join("/"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await started.text();
    assert.equal(started.status, 201, text);
    const handle = JSON.parse(text);

    const rendered = frame(base, registry).stdout;
    assert.match(rendered, new RegExp(handle.id), "the owned process is not in the view");
    assert.match(rendered, /aify-comms/, "the owning service is not in the view");
    assert.doesNotMatch(rendered, /no processes owned/, "the view claimed it owned nothing");
  } finally {
    await stopDaemon(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the view reports the environment's own traffic, and it is NOT zero after use", async () => {
  // The operator asked for a view that shows data moving. A counter that never moves is a label.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-live-"));
  const registry = path.join(dir, "services.json");
  const { child, base } = await startDaemon();
  try {
    // Give it something to count.
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    }
    const rendered = frame(base, registry).stdout;
    const match = /TRAFFIC\s+(\d+) requests/.exec(rendered);
    assert.ok(match, `no traffic line in the view:\n${rendered}`);
    assert.ok(Number(match[1]) >= 3, `traffic read ${match[1]} after at least 3 requests`);
  } finally {
    await stopDaemon(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
