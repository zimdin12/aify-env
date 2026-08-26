#!/usr/bin/env node
// The panel an operator is already watching says HOW the last processes ended.
//
// On 2026-08-26 seven managed workers died in two clusters and the PROCESSES panel simply emptied. It
// could say WHEN the last one went and nothing about how, so the operator asked -- twice -- and every
// answer had to be reconstructed from timestamps in another component's database. The registry records
// the code and the signal now; this is the half that puts them where the question gets asked.
//
// THE VIEW STILL CLAIMS NOTHING IT WAS NOT TOLD. It reports the strings and numbers the registry
// observed and never infers an agent's state from them -- the same boundary the PROCESSES table keeps.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDashboard } from "../lib/tui.mjs";

const base = {
  endpoint: "http://127.0.0.1:8802",
  version: "0.6.0",
  services: [],
  processes: [],
  unknown: [],
  traffic: { requests: 0, bytesOut: 0 },
  nowMs: 1_000_000,
};

const render = (history) =>
  renderDashboard({ ...base, history: { startedTotal: 3, lastExitAtMs: 999_000, ...history } },
    { columns: 120, color: false }).join("\n");

test("a signalled death is named, and named loudly", () => {
  const out = render({ recentExits: [
    { id: "p1", label: "sc-coder", atMs: 940_000, exitCode: null, exitSignal: "SIGKILL" },
  ] });
  assert.match(out, /RECENT EXITS/);
  assert.match(out, /sc-coder/);
  assert.match(out, /killed by SIGKILL/);
});

test("a clean exit says so, and is not mistaken for silence", () => {
  // Zero is the most common exit there is. A truthiness test would drop it and leave the panel saying
  // nothing was reported, which is a different answer.
  const out = render({ recentExits: [
    { id: "p2", label: "sc-tester", atMs: 940_000, exitCode: 0, exitSignal: "" },
  ] });
  assert.match(out, /exited cleanly \(0\)/);
  assert.doesNotMatch(out, /no exit reported/);
});

test("a non-zero exit carries its number", () => {
  const out = render({ recentExits: [
    { id: "p3", label: "a", atMs: 940_000, exitCode: 137, exitSignal: "" },
  ] });
  assert.match(out, /exited 137/);
});

test("an unobserved death says so rather than inventing a zero", () => {
  // A reaper found a corpse, or a caller asked for a stop. Neither watched it end.
  const out = render({ recentExits: [
    { id: "p4", label: "a", atMs: 940_000, exitCode: null, exitSignal: "" },
  ] });
  assert.match(out, /no exit reported/);
  assert.doesNotMatch(out, /exited cleanly/);
});

test("the newest death is at the TOP", () => {
  // A panel is read downward and the death being asked about is the most recent one. The registry
  // stores oldest-first, so getting this backwards would put the interesting row last every time.
  const out = render({ recentExits: [
    { id: "p1", label: "older", atMs: 900_000, exitCode: 0, exitSignal: "" },
    { id: "p2", label: "newest", atMs: 990_000, exitCode: 0, exitSignal: "" },
  ] });
  assert.ok(out.indexOf("newest") < out.indexOf("older"), "the oldest death was listed first");
});

test("an environment that has lost nothing shows no panel at all", () => {
  // The control. A heading with an empty table under it is furniture, and this view is read at a
  // glance during an incident.
  assert.doesNotMatch(render({ recentExits: [] }), /RECENT EXITS/);
  assert.doesNotMatch(render({}), /RECENT EXITS/);
});

test("a process with no label still gets a row", () => {
  // Every managed spawn carries an agent id, but a directly-started process does not, and losing the
  // row would hide exactly the death nobody can attribute.
  const out = render({ recentExits: [
    { id: "p9", label: "", atMs: 940_000, exitCode: null, exitSignal: "SIGTERM" },
  ] });
  assert.match(out, /p9/);
  assert.match(out, /killed by SIGTERM/);
});
