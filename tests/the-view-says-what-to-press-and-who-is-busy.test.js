#!/usr/bin/env node
// The two things the view GAINED on 2026-09-06, tested where they actually reach a human: the render.
//
// WHY THIS FILE EXISTS SEPARATELY. `keys.mjs` proves a keypress routes, `activity.mjs` proves a
// timestamp derives, and both stay green if the renderer draws neither. That is the same
// producer-and-reader-never-meet shape that produced four separate defects in this fleet on
// 2026-09-06 -- a version column fed from a field nothing sends, three health fields dropped before
// their reader, an environment binding written to one carrier and read from another, and a doctor
// row that could never fire. The render is the far end here, so it gets its own tests.
//
// THE HINT IS NOT DECORATION. The operator ran the view, saw their agents, and asked how to switch
// between them -- because nothing on screen said. Bindings nobody wrote down are bindings nobody has,
// so the hint line is part of the feature rather than a nicety on top of it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDashboard } from "../lib/tui.mjs";
import { WORKING_SILENCE_MS } from "../lib/activity.mjs";

const NOW = 1_800_000_000_000;

const SNAPSHOT = {
  version: "0.6.2",
  endpoint: "http://127.0.0.1:8802",
  terminals: { available: true, reason: "" },
  services: [],
  processes: [
    { id: "aaaa-p1", pid: 11, label: "sc-lead", service: "aify-comms", terminal: true, uptimeMs: 60_000 },
  ],
  unknown: [],
  traffic: { requests: 1, bytesOut: 2 },
  nowMs: NOW,
};

const render = (overrides = {}, options = {}) =>
  renderDashboard({ ...SNAPSHOT, ...overrides }, options).join("\n");

/** The row for one agent, so an assertion cannot pass on some other line that happens to match. */
const rowFor = (label, overrides = {}, options = {}) =>
  renderDashboard({ ...SNAPSHOT, ...overrides }, options).find((line) => line.includes(label));

// ── the hint line ───────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: the process table renders at all", () => {
  // Every hint assertion below is "this text is/is not on screen". A renderer producing nothing would
  // satisfy all the NEGATIVE ones perfectly and report green.
  assert.match(render(), /sc-lead/);
  assert.match(render(), /PROCESSES/);
});

test("with a keyboard, the view says what to press", () => {
  const view = render({}, { keys: { enabled: true, canQuit: true } });
  for (const hint of ["move", "jump", "find", "attach", "back"]) {
    assert.match(view, new RegExp(hint), `the hint line does not mention ${hint}`);
  }
  assert.match(view, /1-9/, "the jump keys are not named");
  assert.match(view, /ctrl\+\]/i, "the way back is not named");
});

test("WITHOUT a keyboard there is no hint, because there is nothing to press", () => {
  // `--once`, a pipe and every test render without one. Advertising keys the view cannot receive is
  // worse than saying nothing: it sends the operator to press something that does nothing.
  const view = render();
  assert.doesNotMatch(view, /jump/);
  assert.doesNotMatch(view, /ctrl\+\]/i);
});

test("the DAEMON'S view does not offer `q`, and the client's does", () => {
  // The load-bearing half. In the daemon's own terminal there is no view to leave -- quitting could
  // only mean stopping the environment, and that is Ctrl+C's job, held to one key nobody presses by
  // accident. Offering `q` there would be the screen advertising a way to reap the fleet.
  const daemon = render({}, { keys: { enabled: true, canQuit: false } });
  assert.match(daemon, /attach/, "the daemon lost its hint line entirely");
  assert.doesNotMatch(daemon, /\bq\b\s*quit|quit/, "the daemon's view offered a quit key");

  const client = render({}, { keys: { enabled: true, canQuit: true } });
  assert.match(client, /quit/, "the client's view hides the key that leaves it");
});

test("no hint when nothing is running, because there is nothing to move through", () => {
  const view = render({ processes: [], history: { startedTotal: 0, lastExitAtMs: null } },
    { keys: { enabled: true, canQuit: true } });
  assert.doesNotMatch(view, /jump/);
});

// ── the activity mark ───────────────────────────────────────────────────────────────────────────

test("a lane that just emitted is marked as producing", () => {
  const row = rowFor("sc-lead", {
    processes: [{ ...SNAPSHOT.processes[0], lastOutputAtMs: NOW - 500 }],
  });
  assert.match(row, /●/, "a working lane carries no mark");
});

test("a lane that has gone silent is marked differently", () => {
  const row = rowFor("sc-lead", {
    processes: [{ ...SNAPSHOT.processes[0], lastOutputAtMs: NOW - WORKING_SILENCE_MS - 1000 }],
  });
  assert.match(row, /○/, "a quiet lane carries no mark");
  assert.doesNotMatch(row, /●/, "a quiet lane is marked as working");
});

test("NO EVIDENCE RENDERS AS NOTHING, not as quiet", () => {
  // Every process row from a daemon too old to send the field looks exactly like this, and marking a
  // whole host as silent would be a claim nothing measured. Verified against the operator's own
  // fleet on 2026-09-06: four lanes silent 13 minutes read ○ and one at 0.1s read ●, so the two
  // marks are reachable -- which is what makes this absence meaningful rather than a broken render.
  const row = rowFor("sc-lead");
  assert.doesNotMatch(row, /●|○/, "a process with no activity stamp was given a verdict");
});

test("the mark does not displace the columns that were already there", () => {
  // The activity column is new and leading. A row that lost its pid, agent or title to it would be a
  // worse view than the one before the feature.
  const row = rowFor("sc-lead", {
    processes: [{ ...SNAPSHOT.processes[0], title: "Claude Code", lastOutputAtMs: NOW - 100 }],
  });
  for (const cell of ["aaaa-p1", "11", "sc-lead", "aify-comms", "pty", "Claude Code"]) {
    assert.ok(row.includes(cell), `the row lost ${cell}`);
  }
});

test("THE VIEW STILL CLAIMS NOTHING ABOUT AGENTS", () => {
  // The boundary this file's neighbour `tui.test.js` exists to hold, re-asserted against the new
  // column. The mark is a glyph on purpose: printing `working` beside a `service` column invites
  // reading it as that service's verdict for that agent, which is computed from far more evidence
  // and has an owner. A word here would be a second answer to a question that is not ours.
  const view = render({
    processes: [{ ...SNAPSHOT.processes[0], lastOutputAtMs: NOW - 100 }],
  }, { keys: { enabled: true, canQuit: false } });
  assert.doesNotMatch(view, /\bworking\b/i, "the view printed an agent-status word");
  assert.doesNotMatch(view, /\bblocked\b/i, "a screen-derived state reached this tier");
  assert.doesNotMatch(view, /\bidle\b/i, "the activity mark was rendered as an agent status");
});
