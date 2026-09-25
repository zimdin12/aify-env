// The daemon view's resize listener goes when the view does (v0.7 scan, F26a).
//
// (a) The daemon view's `resize` listener on stdout was never removed: `stop()` returned the
//     dashboard's stop only. Harmless while stop happens only at exit, and a leak the moment it does
//     not.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { startDaemonView } from "../lib/daemon-view.mjs";

test("(a) stopping the daemon view removes its resize listener", async () => {
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 40 });
  let dashboardStopped = 0;
  const view = await startDaemonView({
    endpoint: "e", registryPath: "r", stdout, stdin: { isTTY: false },
    start: async () => ({ stop: () => { dashboardStopped += 1; }, resize: () => {} }),
  });
  assert.equal(stdout.listenerCount("resize"), 1, "the fixture registered no listener");
  view.stop();
  assert.equal(stdout.listenerCount("resize"), 0, "the resize listener outlived the view");
  assert.equal(dashboardStopped, 1, "the dashboard itself was not stopped");
});
