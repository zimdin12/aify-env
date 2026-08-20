#!/usr/bin/env node
// The verifier, run as a verifier is run.
//
// Everything it reports is unit-tested next door. What is only reachable here is the contract a
// caller depends on: the exit statuses, and that --strict actually treats unanswered as not-ok. That
// is the property the whole three-state design exists for, and it lives in one line at the bottom of
// a binary — exactly the kind of line that gets simplified back to a boolean by someone tidying up.
//
// Every endpoint here is 127.0.0.2:1 — set, and reachable by nothing. A verifier test that found a
// real service would be reporting on the operator's live fleet.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DOCTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env-doctor.mjs");
const NOWHERE = "http://127.0.0.2:1";

function runDoctor({ registry, args = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doc-"));
  const registryPath = path.join(dir, "services.json");
  if (registry !== undefined) fs.writeFileSync(registryPath, registry);

  const res = spawnSync(process.execPath, [DOCTOR, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      AIFY_SERVICE_REGISTRY: registryPath,
      // Nowhere, so no environment answers and nothing on this machine is contacted.
      AIFY_ENV_ENDPOINT: NOWHERE,
      AIFY_PROBE_TIMEOUT_MS: "300",
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test("--json emits the three-state shape with an exit code inside it", () => {
  const res = runDoctor({ registry: undefined, args: ["--json"] });
  const report = JSON.parse(res.stdout);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  for (const check of report.checks) {
    assert.ok(["passed", "failed", "unanswered"].includes(check.state), check.state);
    assert.equal(typeof check.ok, "undefined", "a boolean would let the third state collapse");
  }
});

test("without --strict the exit is 0, even with failures to report", () => {
  // Looking at a report must not fail a script that only wanted to look.
  const res = runDoctor({ registry: undefined });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /FAIL/);
});

test("--strict exits non-zero when a check FAILED", () => {
  // No environment is running at 127.0.0.2:1, which is a knowable no.
  const res = runDoctor({ registry: undefined, args: ["--strict"] });
  assert.equal(res.status, 1);
});

test("--strict does NOT exit 0 when a registered service is merely SILENT", () => {
  // The property the third state exists for. If unanswered exited 0 here, a fleet of silent services
  // would look exactly like a healthy one.
  const registry = JSON.stringify({
    version: 1,
    services: { "aify-comms": { endpoint: NOWHERE, mcp: [] } },
  });
  const res = runDoctor({ registry, args: ["--strict", "--json"] });
  const report = JSON.parse(res.stdout);
  const service = report.checks.find((check) => check.id === "aify-comms");
  assert.equal(service.state, "unanswered", "a silent service must not read as failed or passed");
  assert.notEqual(res.status, 0);
});

test("a registered service is actually probed, not assumed", () => {
  // Without this, the check could be reporting on nothing at all and still look right.
  const registry = JSON.stringify({
    version: 1,
    services: { "aify-graph": { endpoint: NOWHERE, mcp: [] } },
  });
  const report = JSON.parse(runDoctor({ registry, args: ["--json"] }).stdout);
  assert.ok(report.checks.some((check) => check.id === "aify-graph"), "the service was never probed");
});

test("a host with NO registry still produces a report", () => {
  // A fresh machine is a legitimate machine, and a verifier that refuses to run on one is useless
  // exactly when somebody is trying to work out why nothing is installed.
  const report = JSON.parse(runDoctor({ registry: undefined, args: ["--json"] }).stdout);
  const registryCheck = report.checks.find((check) => check.id === "registry");
  assert.equal(registryCheck.state, "passed");
  assert.match(registryCheck.detail, /no services/i);
});

test("every failed check carries a fix", () => {
  // A failure without a remedy is a complaint. Enforced at construction, asserted here end to end.
  const report = JSON.parse(runDoctor({ registry: undefined, args: ["--json"] }).stdout);
  for (const check of report.checks.filter((c) => c.state === "failed")) {
    assert.ok(check.fix && check.fix.length > 0, `${check.id} failed without a fix`);
  }
});

test("the human output names the state of every check", () => {
  const res = runDoctor({ registry: undefined });
  const report = JSON.parse(runDoctor({ registry: undefined, args: ["--json"] }).stdout);
  for (const check of report.checks) {
    assert.match(res.stdout, new RegExp(check.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// A report must not contradict itself.
//
// The registry check now says an unrecognised version means "what is registered cannot be read". The
// per-service probes were built by reading that same file anyway, so a v2 registry produced one row
// saying it could not be read and further rows naming services read out of it. Both cannot be true,
// and an operator has no way to tell which line to believe.
//
// Probing entries pulled from a format we just disclaimed is acting on a guess we announced we would
// not make. The registry row already explains the silence, so the services are simply not claimed.

test("an unreadable-version registry yields no per-service rows to contradict it", () => {
  const registry = JSON.stringify({
    version: 2,
    services: { "aify-comms": { endpoint: NOWHERE }, "aify-other": { endpoint: NOWHERE } },
  });
  const report = JSON.parse(runDoctor({ registry, args: ["--json"] }).stdout);
  const ids = report.checks.map((check) => check.id);

  assert.ok(ids.includes("registry"), "the registry check is missing entirely");
  assert.equal(
    ids.includes("aify-comms"),
    false,
    "a service row was built from a registry the report says it cannot read",
  );
  assert.equal(ids.includes("aify-other"), false, "same, for the second service");
});

test("a SUPPORTED-version registry still produces its per-service rows", () => {
  // The negative control. Skipping the probes whenever anything looked odd would make the test above
  // pass while quietly disabling the service checks altogether.
  const registry = JSON.stringify({
    version: 1,
    services: { "aify-comms": { endpoint: NOWHERE } },
  });
  const report = JSON.parse(runDoctor({ registry, args: ["--json"] }).stdout);

  assert.ok(
    report.checks.map((check) => check.id).includes("aify-comms"),
    "a valid registry produced no service row, so the probes are off for everyone",
  );
});
