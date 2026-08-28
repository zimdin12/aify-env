// The label is a value that can be corrected, not a fact fixed at birth.
//
// THE OPERATOR'S RULE, stated 2026-08-28: "a wrapper who is auto registered should not differ from one
// that is registered later on (mid conversation)". Identity does not always exist at spawn. A launcher
// can be started as a plain `claude-aify` with no agent id, register itself minutes later, and be the
// same agent it would have been had it known its name up front.
//
// `POST /processes` takes a label because the caller usually DOES know at spawn time. Building only
// that made the AGENT column correct for one path and permanently blank for every other -- and "blank
// for the paths nobody thought about" is indistinguishable, on screen, from "broken".
//
// aify-env still reads nothing into the string. What changed is WHEN it may be told, not what it
// understands. That boundary is the subject of docs/AIFY_ENV_BOUNDARY.md and this does not move it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ProcessRegistry } from "../lib/process-registry.mjs";
import { handleRequest } from "../lib/protocol.mjs";

/** A runner stub that records what the route asked of it. */
function stubRunner({ found = true } = {}) {
  const calls = [];
  return {
    calls,
    relabel: (id, label) => { calls.push([id, label]); return found; },
    list: () => [],
    exits: () => [],
  };
}

const post = (path, body, deps) => handleRequest({ method: "POST", path, body }, deps);

test("a process learns a name it did not have at spawn", () => {
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "aify-comms", pid: 1, terminal: true });
  assert.equal(entry.label, "", "a spawn with no label must not invent one");

  assert.equal(registry.setLabel(entry.id, "sc-architect"), true);
  assert.equal(registry.get(entry.id).label, "sc-architect");
});

test("relabelling an id the registry never had is a no-op that SAYS so", () => {
  // Both halves matter. It must not throw -- a caller reconciling labels will name a process that has
  // just exited. And it must report false, or that caller cannot tell "done" from "gone" and will keep
  // trying for ever.
  const registry = new ProcessRegistry();
  assert.equal(registry.setLabel("p99", "whoever"), false);
});

test("the label cap applies to the late writer too", () => {
  // A cap enforced on one writer and not the other is not a cap: it is a cap plus a way around it.
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "s", pid: 1, label: "x".repeat(200) });
  assert.equal(entry.label.length, 64, "the spawn-time cap moved");
  registry.setLabel(entry.id, "y".repeat(200));
  assert.equal(registry.get(entry.id).label.length, 64, "the late writer can exceed the spawn cap");
});

test("a non-string label is stored as empty rather than coerced", () => {
  // `String(7)` is "7" and `String({})` is "[object Object]". Either in an AGENT column is worse
  // than a blank, because it looks like a name. `add` already refuses to coerce; this matches it.
  //
  // NULL ALONE DOES NOT TEST THIS, and the first version of this test used only null. A mutation
  // replacing the type guard with `String(label ?? "")` SURVIVED it: both spellings turn null into
  // "". The cases that separate them are the non-null non-strings.
  const registry = new ProcessRegistry();
  for (const bad of [null, undefined, 7, {}, [], true]) {
    const entry = registry.add({ service: "s", pid: 1, label: "real" });
    registry.setLabel(entry.id, bad);
    assert.equal(
      registry.get(entry.id).label, "",
      `${JSON.stringify(bad)} was coerced into a label; a rendered ${JSON.stringify(String(bad))} `
        + "reads as an agent name",
    );
  }
});

test("POST /processes/:id/label relabels and returns 204", async () => {
  const runner = stubRunner();
  const response = await post("/processes/p2/label", { label: "sc-coder" }, { runner, readFile: () => "" });
  assert.equal(response.status, 204);
  assert.deepEqual(runner.calls, [["p2", "sc-coder"]]);
});

test("an empty label is allowed: it is how a caller says 'I no longer know'", async () => {
  // Not a validation gap. An agent can be removed or unbound, and forcing the caller to leave a stale
  // name behind would make the column lie in the one direction that costs most -- naming an agent that
  // is not there.
  const runner = stubRunner();
  const response = await post("/processes/p2/label", { label: "" }, { runner, readFile: () => "" });
  assert.equal(response.status, 204);
  assert.deepEqual(runner.calls, [["p2", ""]]);
});

test("a process this environment does not own is a 404, not a silent success", async () => {
  const runner = stubRunner({ found: false });
  const response = await post("/processes/p9/label", { label: "ghost" }, { runner, readFile: () => "" });
  assert.equal(response.status, 404);
  assert.match(String(response.body?.error ?? response.body?.detail ?? ""), /no such process/i);
});

test("a request with no string label is refused", async () => {
  const runner = stubRunner();
  for (const body of [{}, { label: 7 }, { label: null }, "not an object", null]) {
    const response = await post("/processes/p2/label", body, { runner, readFile: () => "" });
    assert.equal(response.status, 400, `accepted ${JSON.stringify(body)}`);
  }
  assert.deepEqual(runner.calls, [], "a refused request still reached the runner");
});

test("GET is not a way to relabel", async () => {
  // The route table matches on path first; a method that is not declared must not fall through to a
  // handler that mutates.
  const runner = stubRunner();
  const response = await handleRequest(
    { method: "GET", path: "/processes/p2/label" },
    { runner, readFile: () => "" },
  );
  assert.notEqual(response.status, 204);
  assert.deepEqual(runner.calls, []);
});

test("the label route does not shadow the bare /processes/:id route", async () => {
  // `/processes/p2/label` and `/processes/p2` differ by a suffix, and the table is ordered. A match
  // that captured the whole tail would make DELETE /processes/p2 unreachable, or worse, reachable
  // under the wrong id -- the shape protocol.mjs already warns about for /input and /resize.
  const runner = { ...stubRunner(), stop: (id) => { runner.stopped = id; return true; } };
  const response = await handleRequest({ method: "DELETE", path: "/processes/p2" }, { runner, readFile: () => "" });
  assert.notEqual(response.status, 404, "the bare id route stopped matching once /label was added");
});
