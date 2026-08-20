#!/usr/bin/env node
// Reading the shared registry, and asking each service about itself.
//
// TWO PARSERS OF ONE FORMAT IS A DRIFT PROBLEM, so this one reads LESS on purpose. aify-wrapper's
// lib/registry.mjs is the authoritative parser — it validates the whole schema because it renders
// launchers from it. aify-env needs a name and an endpoint, so that is all it reads, and it cannot
// disagree about fields it never looks at. The compatibility that matters is pinned by a test that
// feeds it a file produced by aify-comms' writer.
//
// The other rule here is the one the boundary doc is built on: aify-env ASKS. It does not inspect
// another component's internals, and it does not decide whether a service is healthy — it reports what
// the service said, or that the service said nothing.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readServices, probeService } from "../lib/services.mjs";
import { STATE } from "../lib/health.mjs";

const REGISTRY = JSON.stringify({
  version: 1,
  services: {
    "aify-comms": { endpoint: "http://127.0.0.2:1", endpointEnv: ["AIFY_SERVER_URL"], mcp: [] },
    "aify-graph": { endpoint: "http://127.0.0.2:2", mcp: [] },
  },
});

test("services are read with their endpoints, sorted", () => {
  const services = readServices(REGISTRY);
  assert.deepEqual(services.map((s) => s.name), ["aify-comms", "aify-graph"]);
  assert.equal(services[0].endpoint, "http://127.0.0.2:1");
});

test("an ABSENT registry means no services, not an error", () => {
  // A host with nothing registered is a legitimate state, and it must stay distinguishable from a
  // corrupt file — they have opposite remedies.
  for (const absent of ["", "   ", null, undefined]) {
    assert.deepEqual(readServices(absent), []);
  }
});

test("a MALFORMED registry yields no services rather than throwing", () => {
  // aify-env must still start and still own processes when the registry is broken. It just cannot tell
  // anyone which services exist, and its doctor says so.
  assert.deepEqual(readServices("{not json"), []);
});

test("a service without an endpoint is skipped rather than half-read", () => {
  const registry = JSON.stringify({ version: 1, services: { broken: { mcp: [] } } });
  assert.deepEqual(readServices(registry), []);
});

test("fields aify-env does not use are IGNORED, not validated", () => {
  // Reading less is what keeps this from becoming a second opinion about the schema. A registry the
  // authoritative parser would reject on an unused field must still tell aify-env where to knock.
  const registry = JSON.stringify({
    version: 1,
    services: { "aify-comms": { endpoint: "http://127.0.0.2:1", mcp: "not-an-array", nonsense: 42 } },
  });
  assert.deepEqual(readServices(registry).map((s) => s.name), ["aify-comms"]);
});

// ── asking ───────────────────────────────────────────────────────────────────────

test("a service that answers is reported as PASSED, carrying what it said", () => {
  const check = probeService(
    { name: "aify-comms", endpoint: "http://127.0.0.2:1" },
    { ok: true, body: { status: "healthy", version: "0.6.0" } },
  );
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /0\.6\.0/);
});

test("a service that does not answer is UNANSWERED, never failed", () => {
  // A silent service might be uninstalled, stopped, or on a host that is off. None of those is
  // evidence that it is broken, and calling it failed would send someone debugging a service that is
  // simply not running today.
  const check = probeService(
    { name: "aify-graph", endpoint: "http://127.0.0.2:2" },
    { ok: false, error: "ECONNREFUSED" },
  );
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /ECONNREFUSED/);
});

test("a service that answers UNHEALTHY is reported as FAILED, in its own words", () => {
  // Here the evidence exists and it is bad. That is the one case aify-env may call a failure, because
  // the service said so itself — aify-env still has no opinion of its own.
  const check = probeService(
    { name: "aify-comms", endpoint: "http://127.0.0.2:1" },
    { ok: true, body: { status: "degraded", detail: "database is locked" } },
  );
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.detail, /database is locked/);
});

test("a service answering with something that is not a health report is UNANSWERED", () => {
  // A 200 with HTML is a proxy or a captive portal, not a service saying it is well.
  for (const body of [null, "<html>", 42, {}]) {
    const check = probeService({ name: "x", endpoint: "http://127.0.0.2:1" }, { ok: true, body });
    assert.equal(check.state, STATE.UNANSWERED, JSON.stringify(body));
  }
});

test("aify-env never reports agent status, whatever a service sends", () => {
  // The boundary. Alive is not working, and a service volunteering agent counts must not turn aify-env
  // into a second place that answers questions about agents.
  const check = probeService(
    { name: "aify-comms", endpoint: "http://127.0.0.2:1" },
    { ok: true, body: { status: "healthy", agents: 12, working: 3 } },
  );
  assert.doesNotMatch(check.detail, /working/i);
  assert.doesNotMatch(check.detail, /\b12\b/);
});

test("COMPATIBILITY: a registry as aify-comms writes it is readable here", async () => {
  // The cross-repo contract, exercised against a recorded artifact rather than a live call to a writer
  // at a hardcoded absolute path -- which is what this was, and which made the suite depend on one
  // machine's directory layout. If the writer and this reader ever disagree, every other test in this
  // file still passes while aify-env sees no services at all.
  const fs = await import("node:fs");
  const text = fs.readFileSync(new URL("./fixtures/services-written-by-aify-comms.json", import.meta.url), "utf8");

  const services = readServices(text);
  assert.deepEqual(services.map((s) => s.name), ["aify-comms"]);
  assert.equal(services[0].endpoint, "http://127.0.0.2:1");
});
