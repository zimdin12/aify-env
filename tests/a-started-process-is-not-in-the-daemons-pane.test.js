#!/usr/bin/env node
// A process this daemon starts must not believe it runs in the Herdr pane the daemon runs in.
//
// THE DEFECT. A daemon started from a Herdr pane passes `HERDR_ENV=1` and `HERDR_PANE_ID` to every
// child. An aify launcher reads exactly those to claim "its" pane, so every managed worker claimed the
// DAEMON's pane: renamed it after itself and recorded its own command for Herdr's restore. Measured
// 2026-09-14 on a dedicated instance: three claim records, all naming the daemon's terminal, and the
// daemon's pane labelled for the last worker started -- so a restore would relaunch that worker into
// the daemon's pane. It is not only a dedicated-instance problem: any daemon started from a Herdr pane
// does it, and those have no pane opener, so the fix lives where every start goes through.
//
// ASSERTED ON THE CHILD'S REAL ENVIRONMENT, read back from a real process, on both ways a caller can
// hand one over: an explicit env, and none (inherit the daemon's).

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner, withoutPaneIdentity } from "../lib/runner.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
const IDENTITY = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" };
const READ_ENV = "process.stdout.write(JSON.stringify(process.env))";

/** Start a real node child through the piped branch and return the environment it actually got. */
async function childEnv(env) {
  const runner = new Runner({ openTerminal: null });
  const started = await runner.start({ service: "test-service", fileText: ALLOWED, command: process.execPath, args: ["-e", READ_ENV], env });
  let out = "";
  await new Promise((resolve) => runner.subscribe(started.id, (text) => { out += text; }, resolve));
  return JSON.parse(out);
}

test("THE DEFECT: a child given the daemon's pane identity does not keep it", async () => {
  const got = await childEnv({ ...IDENTITY, HERDR_SOCKET_PATH: "/inv/herdr-tui.sock", HERDR_BIN_PATH: "/bin/herdr", KEEP: "yes", PATH: process.env.PATH });
  for (const name of Object.keys(IDENTITY)) assert.equal(got[name], undefined, `the child inherited ${name}`);
  // THE HERDR ITSELF STAYS REACHABLE: a worker's own pane is reported through it.
  assert.equal(got.HERDR_SOCKET_PATH, "/inv/herdr-tui.sock");
  assert.equal(got.HERDR_BIN_PATH, "/bin/herdr");
  assert.equal(got.KEEP, "yes");
});

test("AND ONE THAT INHERITS THE DAEMON'S ENVIRONMENT does not keep it either", async (t) => {
  const saved = Object.fromEntries(Object.keys(IDENTITY).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, IDENTITY, { AIFY_TEST_MARKER: "inherited" });
  t.after(() => { delete process.env.AIFY_TEST_MARKER; });
  const got = await childEnv(undefined);
  assert.equal(got.AIFY_TEST_MARKER, "inherited", "the child did not inherit the daemon's environment at all");
  for (const name of Object.keys(IDENTITY)) assert.equal(got[name], undefined, `the child inherited ${name}`);
});

test("THE PTY BRANCH gets the same environment", async () => {
  let options = null;
  const terminal = { pid: 1, cols: 80, rows: 24, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {}, destroy: () => {} };
  const runner = new Runner({ openTerminal: (_c, _a, opts) => { options = opts; return terminal; }, loadCheckpoint: null });
  await runner.start({ service: "test-service", fileText: ALLOWED, command: "x", args: [], env: { ...IDENTITY, KEEP: "yes" } });
  assert.deepEqual(options.env, { KEEP: "yes" });
});

test("NEGATIVE CONTROL: with nothing to remove, the environment is handed over untouched", () => {
  // `undefined` means inherit, and building a copy would turn it into a snapshot; an explicit env with
  // no identity in it is passed as the same object.
  assert.equal(withoutPaneIdentity(undefined, { PATH: "/bin" }), undefined);
  const explicit = { PATH: "/bin" };
  assert.equal(withoutPaneIdentity(explicit), explicit);
  const given = { ...IDENTITY, PATH: "/bin" };
  assert.deepEqual(withoutPaneIdentity(given), { PATH: "/bin" });
  assert.equal(given.HERDR_PANE_ID, "w1:p1", "the caller's object was mutated");
});
