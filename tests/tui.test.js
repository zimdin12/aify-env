#!/usr/bin/env node
// The view: services, owned processes, and this environment's own traffic.
//
// Rendering is a pure function from a snapshot to lines. That is not ceremony — it is what lets the
// one rule that matters here be a test rather than a review comment: THE VIEW MAY NOT CLAIM ANYTHING
// ABOUT AGENTS. aify-env knows which processes it started and whether they are alive. Alive is not
// working, and a status column here would make this a second place answering a question that already
// has an owner.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDashboard } from "../lib/tui.mjs";

const SNAPSHOT = {
  version: "0.6.0",
  endpoint: "http://127.0.0.1:8801",
  terminals: { available: false, reason: "node-pty did not load" },
  services: [
    { name: "aify-comms", endpoint: "http://127.0.0.1:8800", state: "passed", detail: "reports healthy" },
    { name: "aify-graph", endpoint: "http://127.0.0.2:2", state: "unanswered", detail: "no answer" },
  ],
  processes: [
    { id: "p1", pid: 4242, service: "aify-comms", terminal: true, uptimeMs: 65_000 },
  ],
  unknown: [],
  traffic: { requests: 12, bytesOut: 34_567 },
};

const render = (overrides = {}) => renderDashboard({ ...SNAPSHOT, ...overrides }).join("\n");

test("registered services are listed with what they said about themselves", () => {
  const view = render();
  assert.match(view, /aify-comms/);
  assert.match(view, /reports healthy/);
});

test("a SILENT service is shown as unanswered, not as down", () => {
  // The distinction a viewer acts on: silent may mean uninstalled or switched off, and showing it as
  // broken sends somebody to debug a service that is simply not running today.
  const view = render();
  assert.match(view, /aify-graph.*unanswered/s);
  assert.doesNotMatch(view, /aify-graph.*(down|failed|broken)/s);
});

test("owned processes are shown with pid and owning service", () => {
  const view = render();
  assert.match(view, /4242/);
  assert.match(view, /p1/);
});

test("THE VIEW CLAIMS NO AGENT STATUS, whatever is in the snapshot", () => {
  // The boundary, enforced rather than remembered. Even handed agent fields, the view must not render
  // them: two components deriving status is how two answers start disagreeing.
  const view = renderDashboard({
    ...SNAPSHOT,
    processes: [{ ...SNAPSHOT.processes[0], agentStatus: "working", agentId: "coder-1" }],
  }).join("\n");
  assert.doesNotMatch(view, /working/i);
  assert.doesNotMatch(view, /coder-1/);
});

test("processes the reaper could not judge are shown, not hidden", () => {
  // Kept rather than reaped is the right call and an invisible one; this is where it stops being
  // invisible.
  const view = render({ unknown: [{ id: "p7", pid: 991 }] });
  assert.match(view, /p7/);
  assert.match(view, /unknown|could not/i);
});

test("no terminal support is stated in the view, not left to be discovered", () => {
  const view = render();
  assert.match(view, /terminal/i);
  assert.match(view, /node-pty/);
});

test("traffic is this environment's OWN io, and is labelled as such", () => {
  const view = render();
  assert.match(view, /12/);
  assert.ok(/req|request/i.test(view));
});

test("an empty host renders without throwing and says it is empty", () => {
  // A fresh machine is the first thing anybody sees, and a view that renders a blank rectangle there
  // is a view that looks broken exactly when somebody is checking whether it works.
  const view = renderDashboard({
    version: "0.6.0",
    endpoint: "http://127.0.0.1:8801",
    terminals: { available: true, reason: "" },
    services: [],
    processes: [],
    unknown: [],
    traffic: { requests: 0, bytesOut: 0 },
  }).join("\n");
  assert.match(view, /no services/i);
  assert.match(view, /no processes/i);
});

test("rendering is pure: the same snapshot renders identically twice", () => {
  // Anything time-derived inside would make the view flicker and make this test flaky, which is the
  // early warning that a clock crept in.
  assert.deepEqual(renderDashboard(SNAPSHOT), renderDashboard(SNAPSHOT));
});
