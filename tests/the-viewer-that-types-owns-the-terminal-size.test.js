#!/usr/bin/env node
// The viewer that last typed or resized owns a terminal's size (lib/terminal-size-owner.mjs).
//
// THE BUG THIS CATCHES. A worker shown in a Herdr pane and in the dashboard console took whichever
// size was sent last, so a dashboard Refresh left the Herdr pane showing redraws for a 157x32 screen
// inside a 40-row pane, with nothing the operator typed there able to fix it. Measured 2026-09-28 from
// the service's `terminal_controls`: `dashboard-attach` resized both scrambled workers last.
//
// EVERYTHING HERE GOES THROUGH THE REAL Runner with a fake PTY that records the ORDER of what reached
// it, because the property is an ordering one: the size must change BEFORE the keystroke is written,
// or the agent reads the key at the wrong width and redraws for it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner } from "../lib/runner.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";
import { CONTROL_FAILED, createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { DASHBOARD_VIEWER, viewerOfControl } from "../lib/plugins/aify-comms/control-viewer.mjs";
import { MAX_VIEWERS, TerminalSizeOwner, viewerFrom } from "../lib/terminal-size-owner.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

/** A Runner over one fake terminal that logs every write and resize, in order. */
async function watchedTerminal() {
  const log = [];
  //: Set true to make the PTY refuse every later resize, as node-pty does once the process is exiting.
  const pty = { refuseResize: false };
  const runner = new Runner({
    openTerminal: () => ({
      pid: 4242,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      write: (data) => { log.push(`write ${data}`); },
      kill: () => {},
      resize: (cols, rows) => {
        if (pty.refuseResize) throw new Error("ioctl failed");
        log.push(`resize ${cols}x${rows}`);
      },
    }),
  });
  const { id } = await runner.start({
    service: "s", fileText: ALLOWED, command: process.execPath, args: ["-e", ""],
  });
  return { runner, id, log, pty };
}

test("a key from a viewer that is not the owner gives the terminal that viewer's size FIRST", async () => {
  const { runner, id, log } = await watchedTerminal();
  runner.resize(id, 157, 40, "attach:pane");
  runner.resize(id, 157, 32, "dashboard");
  log.length = 0;

  assert.equal(runner.write(id, "k", "attach:pane").ok, true);
  assert.deepEqual(log, ["resize 157x40", "write k"]);
});

test("the owner typing again resizes nothing", async () => {
  const { runner, id, log } = await watchedTerminal();
  runner.resize(id, 157, 40, "attach:pane");
  log.length = 0;

  runner.write(id, "a", "attach:pane");
  runner.write(id, "b", "attach:pane");
  assert.deepEqual(log, ["write a", "write b"]);
});

test("ownership moves back and forth with whoever types", async () => {
  const { runner, id, log } = await watchedTerminal();
  runner.resize(id, 157, 40, "attach:pane");
  runner.resize(id, 120, 32, "dashboard");
  log.length = 0;

  runner.write(id, "1", "attach:pane");
  runner.write(id, "2", "dashboard");
  runner.write(id, "3", "dashboard");
  assert.deepEqual(log, ["resize 157x40", "write 1", "resize 120x32", "write 2", "write 3"]);
});

test("a viewer that never declared a size types without resizing anything", async () => {
  const { runner, id, log } = await watchedTerminal();
  runner.resize(id, 157, 40, "attach:pane");
  log.length = 0;

  runner.write(id, "x", "dashboard");
  runner.write(id, "y");
  assert.deepEqual(log, ["write x", "write y"]);
});

test("an UNNAMED resize still applies and takes ownership, so the next named viewer to type takes it back", async () => {
  const { runner, id, log } = await watchedTerminal();
  runner.resize(id, 157, 40, "attach:pane");
  runner.resize(id, 100, 20);
  log.length = 0;

  runner.write(id, "k", "attach:pane");
  assert.deepEqual(log, ["resize 157x40", "write k"]);
});

test("a REFUSED resize makes nobody the owner of a size the terminal does not have", async () => {
  const { runner, id, log } = await watchedTerminal();
  runner.resize(id, 157, 40, "attach:pane");
  assert.equal(runner.resize(id, 0, 32, "dashboard").ok, false);
  log.length = 0;

  runner.write(id, "k", "attach:pane");
  assert.deepEqual(log, ["write k"], "the pane still owns the size, so its key needs no resize");
});

test("the viewer arrives through the protocol on both routes, and a malformed one is refused", async () => {
  const { runner, id, log } = await watchedTerminal();
  const post = (suffix, body) => handleRequest(
    { method: "POST", path: `/processes/${id}/${suffix}`, body }, { runner });

  assert.equal((await post("resize", { cols: 157, rows: 40, viewer: "attach:pane" })).status, 204);
  assert.equal((await post("resize", { cols: 157, rows: 32, viewer: "dashboard" })).status, 204);
  log.length = 0;
  assert.equal((await post("input", { data: "k", viewer: "attach:pane" })).status, 204);
  assert.deepEqual(log, ["resize 157x40", "write k"]);

  for (const viewer of [42, { name: "x" }, "v".repeat(65)]) {
    assert.equal((await post("input", { data: "k", viewer })).status, 400, JSON.stringify(viewer));
    assert.equal((await post("resize", { cols: 1, rows: 1, viewer })).status, 400, JSON.stringify(viewer));
  }
});

test("a terminal remembers a bounded number of viewers, forgetting the least recently active", () => {
  const owner = new TerminalSizeOwner();
  for (let i = 0; i <= MAX_VIEWERS; i += 1) owner.resized(`attach:${i}`, 80 + i, 24);
  assert.equal(owner.sizeBeforeInput("attach:0"), null, "the oldest viewer is forgotten");
  assert.deepEqual(owner.sizeBeforeInput("attach:1"), { cols: 81, rows: 24 }, "the next one is kept");
});

test("the dashboard's path, through PluginProcesses, carries the viewer to the runner", async () => {
  const { runner, id, log } = await watchedTerminal();
  const processes = new PluginProcesses(runner);
  runner.resize(id, 157, 40, "attach:pane");
  processes.resize(id, 157, 32, "dashboard");
  log.length = 0;

  processes.write(id, "d", "dashboard");
  runner.write(id, "p", "attach:pane");
  processes.write(id, "d", "dashboard");
  assert.deepEqual(log, ["write d", "resize 157x40", "write p", "resize 157x32", "write d"]);
});

test("viewerFrom: an older client that names no viewer is accepted as the unnamed one", () => {
  for (const body of [{}, { viewer: null }, { viewer: "" }, null]) {
    assert.deepEqual(viewerFrom(body), { ok: true, value: "" }, JSON.stringify(body));
  }
  assert.deepEqual(viewerFrom({ viewer: "attach:1a2b3c4d" }), { ok: true, value: "attach:1a2b3c4d" });
  assert.equal(viewerFrom({ viewer: 7 }).ok, false);
});

// ── an owed resize the PTY refuses withholds the key (review 2026-09-29) ─────────────────────
// Written anyway, the key lands at the OTHER viewer's size and the sender is told it landed.

/** Both viewers have sized the terminal (the dashboard last), then the PTY stops accepting resizes. */
async function refusingAfterTwoViewers() {
  const terminal = await watchedTerminal();
  terminal.runner.resize(terminal.id, 157, 40, "attach:pane");
  terminal.runner.resize(terminal.id, 157, 32, "dashboard");
  terminal.pty.refuseResize = true;
  terminal.log.length = 0;
  return terminal;
}

test("Runner: a refused owed resize withholds the key and says why", async () => {
  const { runner, id, log } = await refusingAfterTwoViewers();
  const written = runner.write(id, "k", "attach:pane");
  assert.equal(written.ok, false);
  assert.match(written.error, /could not give the terminal attach:pane's size first: ioctl failed/);
  assert.deepEqual(log, [], "the key was written at the other viewer's size");
  assert.equal(runner.write(id, "d", "dashboard").ok, true, "CONTROL: the owner, owing nothing, still types");
  assert.deepEqual(log, ["write d"]);
});

test("protocol: the withheld key is a 409, not a 204", async () => {
  const { runner, id, log } = await refusingAfterTwoViewers();
  const answer = await handleRequest(
    { method: "POST", path: `/processes/${id}/input`, body: { data: "k", viewer: "attach:pane" } }, { runner });
  assert.equal(answer.status, 409);
  assert.deepEqual(log, []);
});

test("dashboard control: a key withheld from the dashboard is reported FAILED", async () => {
  const { runner, id, log, pty } = await watchedTerminal();
  runner.resize(id, 157, 32, "dashboard");
  runner.resize(id, 157, 40, "attach:pane");
  // Now the dashboard owes a resize, and the PTY refuses it.
  pty.refuseResize = true;
  log.length = 0;
  const handles = createHandleBook();
  handles.remember("term-1", id, "sc-lead");
  const reports = [];
  const result = await runOneControl({
    handles,
    control: { id: "ctl-1", terminalId: "term-1", action: "input", body: "k", requestedBy: "dashboard-console" },
    api: { async reportControl(controlId, patch) { reports.push({ controlId, ...patch }); } },
    processes: new PluginProcesses(runner),
  });
  assert.equal(result.outcome, "refused");
  assert.equal(reports[0]?.status, CONTROL_FAILED);
  assert.match(String(reports[0]?.error), /could not give the terminal dashboard's size first/);
  assert.deepEqual(log, [], "the dashboard's key reached the process at the pane's size");
});

// ── only the dashboard's own surfaces are the dashboard (external review, 2026-09-29) ───────
// An auto-answer or an agent typing into a console is not a viewer: it must never snap the PTY back
// to the size of a dashboard console opened once, which scrambles the Herdr pane.

test("viewerOfControl: the dashboard's surfaces are one viewer, every other requester none", () => {
  for (const requestedBy of ["dashboard-console", "dashboard-attach", "dashboard-refresh", " dashboard-console "]) {
    assert.equal(viewerOfControl({ requestedBy }), DASHBOARD_VIEWER, requestedBy);
  }
  // Bare `dashboard` is what a chat message, a Compact and a defaulted input carry: none is a screen.
  for (const requestedBy of ["dashboard", "console-prompt", "sc-lead", "dashboardx", "", undefined]) {
    assert.equal(viewerOfControl({ requestedBy }), "", String(requestedBy));
  }
});

test("an auto-answer through the real control path types without resizing the pane's terminal", async () => {
  const { runner, id, log } = await watchedTerminal();
  const handles = createHandleBook();
  handles.remember("term-1", id, "sc-lead");
  const processes = new PluginProcesses(runner);
  const api = { async reportControl() {} };
  const send = (over) => runOneControl({ handles, api, processes, control: { id: "c", terminalId: "term-1", ...over } });

  await send({ action: "resize", cols: 157, rows: 32, requestedBy: "dashboard-attach" });
  runner.resize(id, 157, 40, "attach:pane");
  log.length = 0;
  await send({ action: "input", body: "1", requestedBy: "console-prompt" });
  await send({ action: "input", body: "x", requestedBy: "sc-lead" });
  // A chat message or a Compact from the dashboard (review of 0.7.6, ST1).
  await send({ action: "input", body: "m", requestedBy: "dashboard" });
  assert.deepEqual(log, ["write 1", "write x", "write m"], "an automated key resized the terminal to the dashboard's size");

  await send({ action: "input", body: "d", requestedBy: "dashboard-console" });
  assert.deepEqual(log.slice(3), ["resize 157x32", "write d"], "CONTROL: a key typed IN the dashboard still takes its size");
});
