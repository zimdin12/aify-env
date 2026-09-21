#!/usr/bin/env node
// What the daemon tears down on the way out, and in which of the shutdown sequence's slots.
//
// EXTERNAL REVIEW, 2026-09-21, finding F. The input socket was stopped from `closeServer`, which
// `lib/shutdown.mjs` deliberately never awaits -- and closing a unix socket UNLINKS its path. So the
// stop finished AFTER the successor had bound the same path, and deleted the successor's socket
// file. PROVEN by the reviewer's execution: the successor kept advertising an address that no longer
// existed, and every attach silently fell back to HTTP until somebody restarted it.
//
// THIS COULD NOT BE TESTED WHERE IT LIVED. The wiring was inside `bin/aify-env.mjs`, and importing
// that file RUNS a daemon, which supersedes the one serving this host -- the reason for the standing
// rule against importing it. Moving the hooks into a module is what makes the order observable.
//
// WHAT IS PROVEN HERE is the ORDER of this daemon's own teardown. That the sequence awaits
// `beforeStop` at all belongs to `lib/shutdown.mjs` and is proven with the rest of it there.

import assert from "node:assert/strict";
import { test } from "node:test";

import { daemonShutdownHooks } from "../lib/shutdown-hooks.mjs";

/** Records every step in the order it COMPLETED, so an unawaited one lands in the wrong place. */
function recorder() {
  const done = [];
  const step = (name, ms) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    done.push(name);
  };
  return { done, step };
}

test("the input socket is closed before the daemon exits, not whenever it gets round to it", async () => {
  const { done, step } = recorder();
  // THE SOCKET IS THE SLOW ONE, and that is what makes this able to fail. With it faster than the
  // plugins, a stop that was fired and forgotten still finishes first and the order looks right --
  // the first version of this test was written that way and passed against the defect.
  const socket = { stop: step("socket", 60) };
  const hooks = daemonShutdownHooks({
    runner: {},
    stopView: () => done.push("view"),
    inputSocket: () => socket,
    servicePlugins: { stopAll: step("plugins", 20) },
    closeHttpServer: () => done.push("http"),
    clearOwned: () => {}, exit: () => {}, write: () => {},
  });

  await hooks.beforeStop();
  assert.deepEqual(done, ["view", "socket", "plugins"],
    "the socket's unlink must have HAPPENED by the time this resolves, not merely been started");
});

test("closing the listener does not touch the socket at all", () => {
  // The slot that is not awaited must own nothing whose completion matters. An HTTP server with an
  // open SSE stream can take as long as that stream lives to finish closing, which is exactly why.
  const touched = [];
  const hooks = daemonShutdownHooks({
    runner: {},
    stopView: () => {},
    inputSocket: () => ({ stop: async () => { touched.push("socket"); } }),
    servicePlugins: { stopAll: async () => {} },
    closeHttpServer: () => touched.push("http"),
    clearOwned: () => {}, exit: () => {}, write: () => {},
  });

  hooks.closeServer();
  assert.deepEqual(touched, ["http"], "a stop started here would be a stop nobody waits for");
});

test("a host that never opened a socket still shuts down", async () => {
  // The socket is an optimisation; on WSL, or where the bind failed, there is simply none.
  const hooks = daemonShutdownHooks({
    runner: {},
    stopView: () => {},
    inputSocket: () => null,
    servicePlugins: { stopAll: async () => {} },
    closeHttpServer: () => {},
    clearOwned: () => {}, exit: () => {}, write: () => {},
  });
  await hooks.beforeStop();
});

test("the parts are read when the signal arrives, not when this is built", async () => {
  // The HTTP server and the socket are both assigned AFTER this object exists -- one is still in its
  // temporal dead zone, the other does not exist until the port is bound. Reading either eagerly
  // would capture nothing, and the teardown would quietly skip it.
  let socket = null;
  const stopped = [];
  const hooks = daemonShutdownHooks({
    runner: {},
    stopView: () => {},
    inputSocket: () => socket,
    servicePlugins: { stopAll: async () => {} },
    closeHttpServer: () => {},
    clearOwned: () => {}, exit: () => {}, write: () => {},
  });

  socket = { stop: async () => { stopped.push("socket"); } };
  await hooks.beforeStop();
  assert.deepEqual(stopped, ["socket"], "a socket opened after boot must still be closed at shutdown");
});
