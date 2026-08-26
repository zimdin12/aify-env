#!/usr/bin/env node
// The panel reports what the environment SAID about terminals, not the fact that it said something.
//
// THE BUG. `collectSnapshot` built the block as `available: Boolean(env.body?.terminals)` -- and
// `env.body.terminals` is an OBJECT, `{available, reason, conptyDll}`. `Boolean` of any object is
// TRUE, so the panel printed "● terminals available" on a host whose environment was reporting
// terminals UNAVAILABLE. That is exactly the reading the boot line exists to prevent: every console
// renders nothing and the one indicator on screen says the machine is fine.
//
// It also replaced the real `reason` with the phrase "reported by the environment", which is not a
// reason, and dropped `conptyDll` -- so an operator running the conpty-DLL experiment against a live
// fleet could not see whether it had taken. Found 2026-08-26 when the flag WAS live on /health and
// the panel showed nothing, which is the same class of gap the flag reporting was added to close.

import assert from "node:assert/strict";
import { test } from "node:test";

import { collectSnapshot } from "../lib/dashboard.mjs";

/** A stand-in for the environment's /health, so this test is about the mapping and not a machine. */
function fakeFetch(body, { answers = true } = {}) {
  return async (url) => {
    if (!answers || !String(url).includes("8802")) {
      throw Object.assign(new Error("ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } });
    }
    return { json: async () => body };
  };
}

const base = {
  version: "0.6.0",
  processes: [],
  unknown: [],
  history: { startedTotal: 0, lastExitAtMs: null },
  traffic: { requests: 0, bytesOut: 0 },
};

const snapshot = (terminals, opts) => collectSnapshot({
  endpoint: "http://127.0.0.1:8802",
  registryPath: "/nope.json",
  fetchImpl: fakeFetch({ ...base, terminals }, opts),
  readFile: () => { throw new Error("ENOENT"); },
  nowMs: () => 1000,
});

test("an environment reporting terminals UNAVAILABLE is reported unavailable", async () => {
  const snap = await snapshot({ available: false, reason: "node-pty did not load: MODULE_NOT_FOUND" });
  assert.equal(snap.terminals.available, false,
    "the panel said terminals were available while the environment said they were not");
  assert.match(snap.terminals.reason, /node-pty did not load/,
    "the environment's real reason was replaced with a phrase that is not a reason");
});

test("an environment reporting terminals AVAILABLE is reported available", async () => {
  // The control. A mapping that answered false to everything would pass the test above.
  const snap = await snapshot({ available: true, reason: "" });
  assert.equal(snap.terminals.available, true);
});

test("the conpty backend flag survives into the snapshot", async () => {
  // It is the whole point of reporting it: an experiment whose setting cannot be seen is not one.
  assert.equal((await snapshot({ available: true, reason: "", conptyDll: true })).terminals.conptyDll, true);
  assert.equal((await snapshot({ available: true, reason: "" })).terminals.conptyDll, false);
});

test("a missing or malformed block is UNAVAILABLE with a reason, not available", async () => {
  // Fail closed. An environment that answered without a terminals block has told us nothing, and
  // "nothing" must not read as "fine" -- this repo's rule, paid for in incidents.
  for (const bad of [undefined, null, "yes", 42]) {
    const snap = await snapshot(bad);
    assert.equal(snap.terminals.available, false, `a ${typeof bad} block read as available`);
    assert.ok(snap.terminals.reason, "no reason was given for the unavailability");
  }
});

test("an environment that did not answer at all says so", async () => {
  const snap = await snapshot({ available: true }, { answers: false });
  assert.equal(snap.terminals.available, false);
  assert.match(snap.terminals.reason, /no environment answered/);
});
