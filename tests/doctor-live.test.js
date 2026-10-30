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

import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";
import { sealedDoctorEnv } from "./_sealed-doctor-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "..", "bin", "aify-env.mjs");
const DOCTOR = path.join(HERE, "..", "bin", "aify-env-doctor.mjs");

function startDaemon() {
  return new Promise((resolve, reject) => {
    // SEALED, like daemon.test.js: the daemon records what it owns and REAPS from that record at
    // startup. Pointed at the real ~/.aify path, a test could kill a process it never started.
    const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-env-rec-")), "owned.json");
    // AND SEALED AGAINST THE REGISTRY, which this spawn was NOT until 2026-09-03 -- it spread
    // `process.env` and overrode only the record. So the daemon resolved the operator's real
    // `~/.aify/services.json`, found the live aify-comms, loaded its plugin and CLAIMED A SPAWN.
    //
    // THAT IS THE CLAIM LEAK, and it explains every symptom the hunt for it recorded: transient,
    // because this daemon is killed seconds later and the service self-heals in about two minutes;
    // unfindable by bisect, because it is a race between the claim pass firing and `stopDaemon`;
    // and it only ever showed up on a FULL suite run, because that is when this file runs at all.
    // Sealing the process record but not the registry is the exact shape already written down as
    // "sealing an env var is not sealing an INPUT" -- a child sealed of every carrier still found
    // the fleet through a FILE.
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: sealedDaemonEnv({ AIFY_ENV_PROCESS_RECORD: record }),
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
    // A home of its own (_sealed-doctor-env.mjs), so the operator's claude login and ~/.aify are not read.
    env: sealedDoctorEnv({
      AIFY_ENV_ENDPOINT: endpoint,
      AIFY_SERVICE_REGISTRY: registryPath,
      AIFY_PROBE_TIMEOUT_MS: "1000",
    }),
  });
}

/**
 * The doctor's JSON report, or an error that says why there is none.
 *
 * "Unexpected end of JSON input" WAS ALL A FAILED RUN SAID (2026-10-28, doctor-live:217 on a host short of memory):
 * the doctor printed nothing, and the exit status, signal and stderr that would have said why were thrown away. A
 * failing doctor still prints a report, so the status is not asserted here; only a report that does not parse is.
 */
function reportOf(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`the doctor printed no report (${error.message}): status ${result.status}, signal ${result.signal}, `
      + `spawn error ${result.error?.code ?? "none"}, stdout ${JSON.stringify(String(result.stdout ?? "").slice(-200))}, `
      + `stderr ${JSON.stringify(String(result.stderr ?? "").slice(-800))}`);
  }
}

// ONE LIVE DAEMON, ONE DOCTOR RUN, then one more once it has stopped. Four tests used to boot a daemon each to run the
// doctor once against it; a single live report answers all four, and the stopped run is BOTH DIRECTIONS' other half.
test("against ONE live environment the doctor reports it, its processes, a silent service and current code; stopped, it fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doc-live-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify({
    version: 1,
    services: { "aify-comms": { endpoint: "http://127.0.0.2:1", mcp: [] } },
  }));
  const { child, base } = await startDaemon();
  try {
    const report = reportOf(runDoctor(base, registry));
    const row = (id) => report.checks.find((c) => c.id === id);

    // BOTH DIRECTIONS, the live half: the environment check passes against a live one.
    assert.equal(row("environment").state, "passed", `a live environment was not seen: ${row("environment").detail}`);
    assert.match(row("environment").detail, /127\.0\.0\.1/);

    // Owned processes are reported as PASSED rather than unanswered.
    assert.equal(row("processes").state, "passed", `processes read ${row("processes").state}: ${row("processes").detail}`);
    assert.match(row("processes").detail, /0 process/);

    // A live environment plus an unreachable SERVICE gives passed AND unanswered in one report.
    assert.equal(row("aify-comms").state, "unanswered", "a silent service must not read as passed or failed");
    assert.ok(report.counts.passed > 0 && report.counts.unanswered > 0, JSON.stringify(report.counts));

    // PROVEN ON A REAL DAEMON: code-current passes, and the two identities it compares AGREE.
    assert.ok(row("code-current"), "the report carried no code-current row");
    assert.equal(row("code-current").state, "passed",
      `a daemon that just booted from this checkout did not read as current: ${row("code-current").detail}. `
      + "If this says `stale`, the two recipes have diverged and every host will read stale forever.");
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.build, health.codeOnDisk,
      "a live daemon's boot build and disk build disagree on an unmodified checkout");
    assert.match(String(health.build), /^[0-9a-f]{8}$/,
      `the build identity is not a hash: ${JSON.stringify(health.build)}`);
  } finally {
    await stopDaemon(child);
  }

  // BOTH DIRECTIONS, the other half: the same probe against the stopped environment fails, with a fix.
  const dead = reportOf(runDoctor(base, registry));
  const deadCheck = dead.checks.find((c) => c.id === "environment");
  assert.equal(deadCheck.state, "failed", "the probe reported a stopped environment as running");
  assert.ok(deadCheck.fix.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("NEGATIVE CONTROL, ON THE SAME REAL DAEMON: change the disk and the row goes FAILED", async () => {
  // Without this, the probe above has only ever been observed saying PASSED -- and a check that
  // cannot be watched go red is a rumour. It is also the cheapest way to prove the disk half is
  // genuinely re-read rather than being the boot value under a second name, which would pass the
  // positive test perfectly and make the whole feature inert.
  //
  // IT WRITES INTO THE REAL PACKAGE TREE, because that is the only thing this daemon hashes, and
  // removes it in `finally`. The name is unmistakable and unique so a crashed run leaves something
  // obviously disposable rather than something that looks like source.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doc-live-"));
  const registry = path.join(dir, "services.json");
  const scratch = path.join(HERE, "..", "lib", `__disk-build-negative-control-${process.pid}.mjs`);
  const { child, base } = await startDaemon();
  try {
    const before = await fetch(`${base}/health`).then((r) => r.json());
    fs.writeFileSync(scratch, "// a file that exists only for the length of this test\n");

    // Past the cache window, which is what makes this a wait rather than a poll: `onDisk` is
    // deliberately answered from a cache so a heartbeat every 30 seconds does not re-hash the
    // package, and a reading taken sooner would be the cached one and prove nothing.
    let after = before;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && after.codeOnDisk === before.codeOnDisk) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      after = await fetch(`${base}/health`).then((r) => r.json());
    }

    assert.notEqual(after.codeOnDisk, before.codeOnDisk,
      "a file was added to the package and the disk build never moved, so `onDisk` is not re-reading");
    assert.equal(after.build, before.build,
      "the BOOT build moved. It is the identity of what this process loaded and must not change while "
      + "it runs, or `did my restart take?` becomes unanswerable");

    const report = reportOf(runDoctor(base, registry));
    const check = report.checks.find((c) => c.id === "code-current");
    assert.equal(check.state, "failed", `the disk changed and the row still read ${check.state}`);
    assert.match(check.fix, /reaps the managed workers/,
      "the row sent an operator to restart without naming what the restart costs them");
  } finally {
    fs.rmSync(scratch, { force: true });
    await stopDaemon(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
