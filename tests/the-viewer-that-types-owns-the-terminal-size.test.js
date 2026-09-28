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
import { MAX_VIEWERS, TerminalSizeOwner, viewerFrom } from "../lib/terminal-size-owner.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

/** A Runner over one fake terminal that logs every write and resize, in order. */
async function watchedTerminal() {
  const log = [];
  const runner = new Runner({
    openTerminal: () => ({
      pid: 4242,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      write: (data) => { log.push(`write ${data}`); },
      kill: () => {},
      resize: (cols, rows) => { log.push(`resize ${cols}x${rows}`); },
    }),
  });
  const { id } = await runner.start({
    service: "s", fileText: ALLOWED, command: process.execPath, args: ["-e", ""],
  });
  return { runner, id, log };
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
