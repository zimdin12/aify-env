#!/usr/bin/env node
// The doctor against a REAL running environment.
//
// The other doctor tests all run with nothing listening, so every one of them exercises the failure
// and unanswered paths. That is half a probe. A checker that has only ever been observed saying NO
// cannot be trusted when it says no — the same rule this project applies to every other measurement,
// applied to the measuring tool itself.
//
// So this starts an actual aify-env, asks the actual doctor, and requires it to say PASSED. And then
// it requires the reverse in the same run: with the environment stopped, the same check must fail.
// One run, both directions, no room for a probe that always answers the same thing.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "..", "bin", "aify-env.mjs");
const DOCTOR = path.join(HERE, "..", "bin", "aify-env-doctor.mjs");

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

/** Run the doctor with a registry path of our own, so it never reads the operator's. */
function runDoctor(endpoint, registryPath) {
  return spawnSync(process.execPath, [DOCTOR, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      AIFY_ENV_ENDPOINT: endpoint,
      AIFY_SERVICE_REGISTRY: registryPath,
      AIFY_PROBE_TIMEOUT_MS: "1000",
    },
  });
}

test("BOTH DIRECTIONS: the environment check passes against a live one and fails without it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doc-live-"));
  const registry = path.join(dir, "services.json");
  const { child, base } = await startDaemon();

  let live;
  try {
    // POSITIVE. This is the half every other doctor test is missing.
    live = JSON.parse(runDoctor(base, registry).stdout);
    const check = live.checks.find((c) => c.id === "environment");
    assert.equal(check.state, "passed", `a live environment was not seen: ${check.detail}`);
    assert.match(check.detail, /127\.0\.0\.1/);
  } finally {
    await stopDaemon(child);
  }

  // NEGATIVE, same endpoint, same run. If the probe answered "passed" for a port nothing is on, the
  // positive above would have proved nothing at all.
  const dead = JSON.parse(runDoctor(base, registry).stdout);
  const deadCheck = dead.checks.find((c) => c.id === "environment");
  assert.equal(deadCheck.state, "failed", "the probe reported a stopped environment as running");
  assert.ok(deadCheck.fix.length > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("against a live environment, owned processes are reported as PASSED rather than unanswered", async () => {
  // With nothing listening this reads `unanswered`, because nobody asked the thing that owns them.
  // With something listening it must become a real answer, or the distinction is decorative.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doc-live-"));
  const registry = path.join(dir, "services.json");
  const { child, base } = await startDaemon();
  try {
    const report = JSON.parse(runDoctor(base, registry).stdout);
    const check = report.checks.find((c) => c.id === "processes");
    assert.equal(check.state, "passed", `processes read ${check.state}: ${check.detail}`);
    assert.match(check.detail, /0 process/);
  } finally {
    await stopDaemon(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live environment plus an unreachable SERVICE gives passed AND unanswered in one report", async () => {
  // The shape the three-state design exists for, in a single real run: something verified, something
  // known broken, something that could not be reached. A report that can only ever show one of those
  // is not carrying the distinction it claims to.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doc-live-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify({
    version: 1,
    // Set, and reachable by nothing. Never the operator's real service.
    services: { "aify-comms": { endpoint: "http://127.0.0.2:1", mcp: [] } },
  }));

  const { child, base } = await startDaemon();
  try {
    const result = runDoctor(base, registry);
    const report = JSON.parse(result.stdout);
    const states = Object.fromEntries(report.checks.map((c) => [c.id, c.state]));
    assert.equal(states.environment, "passed");
    assert.equal(states["aify-comms"], "unanswered", "a silent service must not read as passed or failed");
    assert.ok(report.counts.passed > 0 && report.counts.unanswered > 0, JSON.stringify(report.counts));
  } finally {
    await stopDaemon(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
