#!/usr/bin/env node
// The request contract, tested without a socket.
//
// Phase 8 is written against this, so the shape matters more than the transport. Keeping the handler
// pure means the rules below are pinned by fast tests rather than by a listener that has to be started,
// bound and torn down — and a test that has to bind a port is one that fails for reasons unrelated to
// the rule it was checking.
//
// The rule with teeth: REGISTRATION IS NOT AUTHORISATION. A request from a registered service is
// allowlist-checked exactly like any other. A host that runs whatever a known caller asks for is one
// compromised service away from running anything.

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest } from "../lib/protocol.mjs";

const ALLOWED = 'HARNESS_WRAPPER_VERSION="0.6.0"';

/** A stand-in runner: records what it was asked to do without doing any of it. */
function fakeRunner() {
  const started = [];
  const stopped = [];
  return {
    started,
    stopped,
    async start(spec) {
      started.push(spec);
      return { id: "p1", pid: 111, terminal: false, service: spec.service };
    },
    async stop(id) {
      stopped.push(id);
    },
    list: () => [{ id: "p1", pid: 111, service: "aify-comms", terminal: false }],
  };
}

const deps = (overrides = {}) => ({
  runner: fakeRunner(),
  readFile: () => ALLOWED,
  version: "0.6.0",
  unknown: [],
  terminals: { available: false, reason: "node-pty did not load" },
  traffic: { requests: 7, bytesOut: 1234 },
  ...overrides,
});

test("GET /health reports what this environment owns", async () => {
  const d = deps();
  const res = await handleRequest({ method: "GET", path: "/health" }, d);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "healthy");
  assert.equal(res.body.version, "0.6.0");
  assert.equal(res.body.processes.length, 1);
});

test("GET /health NEVER reports agent status", async () => {
  // aify-env knows processes. Alive is not working, and the moment this body carries an agent verdict
  // there are two places deriving it.
  const res = await handleRequest({ method: "GET", path: "/health" }, deps());
  const serialised = JSON.stringify(res.body);
  assert.doesNotMatch(serialised, /"(working|idle|busy|thinking)"/i);
});

test("POST /processes starts one for the named service", async () => {
  const d = deps();
  const res = await handleRequest({
    method: "POST",
    path: "/processes",
    body: { service: "aify-comms", launcher: "/bin/claude-aify", args: ["--managed"] },
  }, d);
  assert.equal(res.status, 201);
  assert.equal(res.body.id, "p1");
  assert.equal(d.runner.started.length, 1);
  assert.equal(d.runner.started[0].service, "aify-comms");
});

test("a request naming NO service is refused", async () => {
  // Every process must have an owner, or the registry cannot say whose work it is and a reaper cannot
  // reason about orphans.
  const d = deps();
  const res = await handleRequest({
    method: "POST", path: "/processes", body: { launcher: "/bin/claude-aify" },
  }, d);
  assert.equal(res.status, 400);
  assert.equal(d.runner.started.length, 0);
});

test("REGISTRATION IS NOT AUTHORISATION: a refused launcher is refused from a known service", async () => {
  const d = deps({ readFile: () => "#!/bin/bash\nrm -rf /\n" });
  const res = await handleRequest({
    method: "POST",
    path: "/processes",
    body: { service: "aify-comms", launcher: "/bin/nasty" },
  }, d);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /marker/i);
  assert.equal(d.runner.started.length, 0, "a refused launcher was started anyway");
});

test("a launcher that cannot be READ is refused, not assumed fine", async () => {
  // Fail closed. "I could not open it" must never become "go ahead".
  const d = deps({ readFile: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
  const res = await handleRequest({
    method: "POST", path: "/processes", body: { service: "s", launcher: "/gone" },
  }, d);
  assert.equal(res.status, 403);
  assert.equal(d.runner.started.length, 0);
});

test("DELETE /processes/:id stops it", async () => {
  const d = deps();
  const res = await handleRequest({ method: "DELETE", path: "/processes/p1" }, d);
  assert.equal(res.status, 204);
  assert.deepEqual(d.runner.stopped, ["p1"]);
});

test("stopping something unknown is 204 too, because stopping is idempotent", async () => {
  const d = deps();
  const res = await handleRequest({ method: "DELETE", path: "/processes/never" }, d);
  assert.equal(res.status, 204);
});

test("GET /processes lists what is owned, with the service that owns each", async () => {
  const res = await handleRequest({ method: "GET", path: "/processes" }, deps());
  assert.equal(res.status, 200);
  assert.equal(res.body.processes[0].service, "aify-comms");
});

test("an unknown route is 404 rather than a default action", async () => {
  const res = await handleRequest({ method: "GET", path: "/anything" }, deps());
  assert.equal(res.status, 404);
});

test("an unsupported method on a known route is 405, not a silent GET", async () => {
  const res = await handleRequest({ method: "PATCH", path: "/processes" }, deps());
  assert.equal(res.status, 405);
});

test("a body that is not an object is refused rather than coerced", async () => {
  const d = deps();
  for (const body of [null, "text", 42, []]) {
    const res = await handleRequest({ method: "POST", path: "/processes", body }, d);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(d.runner.started.length, 0);
});

test("the error body always carries a human reason", async () => {
  for (const request of [
    { method: "GET", path: "/nope" },
    { method: "POST", path: "/processes", body: {} },
  ]) {
    const res = await handleRequest(request, deps());
    assert.ok(res.body.error && res.body.error.length > 0, JSON.stringify(request));
  }
});

test("GET /health reports terminal support, so a consumer need not guess", async () => {
  // The TUI and the doctor both need it, and inferring it from output that looks slightly wrong is
  // exactly the guessing this field removes.
  const res = await handleRequest({ method: "GET", path: "/health" }, deps());
  assert.equal(res.body.terminals.available, false);
  assert.match(res.body.terminals.reason, /node-pty/);
});

test("GET /health reports this environment's OWN traffic", async () => {
  // The operator asked for a view that shows data moving. This is the only traffic aify-env can
  // honestly report: its own. It has no visibility into what a service does elsewhere.
  const res = await handleRequest({ method: "GET", path: "/health" }, deps());
  assert.equal(res.body.traffic.requests, 7);
  assert.equal(res.body.traffic.bytesOut, 1234);
});
