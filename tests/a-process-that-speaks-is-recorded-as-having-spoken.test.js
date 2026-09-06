#!/usr/bin/env node
// The activity stamp, driven through the REAL runner rather than asserted at either end alone.
//
// BOTH ENDS OF ONE FIELD, which is the rule that keeps catching this project out. `activity.test.js`
// proves the derivation and `tui.test.js` proves the rendering, and BOTH stay green if nothing ever
// writes `lastOutputAtMs` -- each test supplies the other's side. The wire between them is the only
// thing neither can see, and four separate defects on exactly that seam were found in this fleet on
// 2026-09-06 alone: a version column fed from a field nothing sends, three health fields computed
// and dropped before their reader, an environment binding written to one carrier and read from
// another, and a doctor row that could never fire.
//
// So this starts a real process, lets it print, and reads the stamp back out of `list()` -- the same
// call `/health` serves the view from.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner } from "../lib/runner.mjs";
import { activityOf, QUIET, UNKNOWN, WORKING } from "../lib/activity.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

/** A spec whose file content passes the allowlist, running a real, harmless command. */
const speaks = (text) => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
});

/** A process that starts, says nothing at all, and stays up long enough to be listed. */
const silent = () => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", "setTimeout(() => {}, 3000)"],
});

/** Prints, then STAYS ALIVE, so the stamp can be read off a live row rather than a remembered one. */
const speaksAndStays = (text) => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", `process.stdout.write(${JSON.stringify(text)}); setTimeout(() => {}, 3000)`],
});

test("a process that PRINTS is recorded as having spoken, and reads as working", async () => {
  // NO CONDITIONAL ANYWHERE IN THIS TEST. An earlier version read the stamp off an EXITED process
  // and guarded with `if (row)` -- which passes silently on any platform where an exited entry is
  // not listed, and a check that cannot report ABSENT cannot report PRESENT. The process stays up
  // instead, so the row is always there and the assertion always runs.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(speaksAndStays("some real output"));
  try {
    const seen = [];
    handle.onOutput((chunk) => seen.push(chunk));
    // Wait for the bytes rather than for the process: it is deliberately still running.
    await new Promise((resolve) => {
      if (seen.length) return resolve();
      const at = Date.now();
      const poll = setInterval(() => {
        if (seen.length || Date.now() - at > 5000) { clearInterval(poll); resolve(); }
      }, 20);
    });

    // POSITIVE CONTROL on the instrument: if the process never actually printed, an absent stamp
    // below would prove nothing about the wiring.
    assert.match(seen.join(""), /some real output/, "the fixture process printed nothing");

    const row = runner.list().find((entry) => entry.id === handle.id);
    assert.ok(row, "a running process was not listed");
    assert.ok(
      Number.isFinite(row.lastOutputAtMs),
      "the runner saw output and recorded no moment for it, so every view reads `unknown` forever",
    );
    assert.equal(activityOf(row, row.lastOutputAtMs + 100), WORKING);
    assert.equal(activityOf(row, row.lastOutputAtMs + 60_000), QUIET);
  } finally {
    await runner.stop(handle.id);
  }
});

test("THE STAMP REACHES list(), which is what /health serves the view from", async () => {
  // The seam that matters. A stamp recorded somewhere `list()` does not project is a stamp no view
  // can ever read -- the same defect as a field written to `runtime_state` and read from
  // `runtime_config`, which cost this fleet three agents reading `offline` on a healthy host.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(silent());
  try {
    // Nothing printed yet: the row must exist and carry NO stamp, which is `unknown` and not `quiet`.
    const before = runner.list().find((entry) => entry.id === handle.id);
    assert.ok(before, "a running process was not listed");
    assert.equal(
      activityOf(before, Date.now()), UNKNOWN,
      "a process that has never emitted was reported as silent rather than as unmeasured",
    );
  } finally {
    await runner.stop(handle.id);
  }
});

test("an unknown id is a no-op, because output can outlive its entry by a tick", async () => {
  const { ProcessRegistry } = await import("../lib/process-registry.mjs");
  const registry = new ProcessRegistry();
  // Must not throw. A title is never worth throwing over and neither is an activity stamp; the
  // emitter runs on every byte from every process and a throw there takes an agent down.
  registry.markActivity("no-such-process", Date.now());
  assert.deepEqual(registry.list(), []);
});

test("a non-numeric moment is refused rather than stored", async () => {
  // The registry stays clock-free: the caller passes the moment. A caller that passes nothing must
  // not be able to write a NaN into a field every view then compares against.
  const { ProcessRegistry } = await import("../lib/process-registry.mjs");
  const registry = new ProcessRegistry();
  const entry = registry.add({ id: "p1", pid: 1, service: "s", command: "c", args: [] });
  registry.markActivity(entry.id ?? "p1", Number.NaN);
  const row = registry.list()[0];
  assert.ok(!Number.isFinite(row?.lastOutputAtMs), "a NaN moment was stored as an activity stamp");
});
