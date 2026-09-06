#!/usr/bin/env node
// Ctrl+C must hand the operator's terminal back before the process exits.
//
// FOUND BY AN INDEPENDENT REVIEW, 2026-09-06, and it is the sharpest kind of defect this project
// produces: an OLD SHAPE that became damaging the moment something new relied on it.
//
// `createShutdown` calls `beforeStop()` WITHOUT awaiting it -- deliberately, so a hanging plugin
// cannot delay a teardown -- while the daemon passes an ASYNC callback. Everything after the first
// `await` in that callback therefore runs only if the process survives to run it, and on this path
// it does not: `exit` is `process.exit(0)`.
//
// That was cosmetic while the view only stopped a redraw timer. It stopped being cosmetic when the
// daemon's view took a KEYBOARD, because releasing raw mode became the last thing in that callback.
// One Ctrl+C would have exited the daemon leaving the operator's shell in raw mode -- no echo, a
// stdin listener still attached -- and the double-Ctrl+C reflex `shutdown.mjs` is explicitly
// designed for skips the callback's tail unconditionally.
//
// SO THE ORDER IS THE FIX, and the order is what this file pins. The screen is released
// synchronously, before the first await. Nothing here asserts on `beforeStop` being awaited: making
// it awaited would let a hanging plugin hold the terminal, which is the same failure by a longer
// route.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createShutdown } from "../lib/shutdown.mjs";

/** The daemon's own wiring, with the two effects made observable. */
function daemon({ pluginStopDelayMs = 0 } = {}) {
  const events = [];
  let rawMode = true;
  const stopDashboard = () => { rawMode = false; events.push("screen-released"); };
  const stopAll = async () => {
    if (pluginStopDelayMs > 0) await new Promise((r) => setTimeout(r, pluginStopDelayMs));
    else await Promise.resolve();
    events.push("plugins-stopped");
  };
  const shutdown = createShutdown({
    runner: { list: () => [], stop: async () => {} },
    closeServer: () => {},
    clearOwned: () => {},
    write: () => {},
    // EXACTLY THE DAEMON'S CALLBACK SHAPE. A test that passed a synchronous function here would
    // prove nothing: async is the whole defect.
    beforeStop: async () => { stopDashboard(); await stopAll(); },
    exit: () => { events.push(`exit(rawMode=${rawMode})`); },
  });
  return { shutdown, events, rawAtExit: () => events.find((e) => e.startsWith("exit(")) };
}

test("POSITIVE CONTROL: the shutdown runs and exits at all", async () => {
  // Every assertion below reads the recorded exit event. A shutdown that never reached `exit` would
  // make them fail rather than pass vacuously -- but a shutdown that never released the screen
  // would ALSO produce no `screen-released`, so both halves need to be observable.
  const d = daemon();
  await d.shutdown("SIGINT");
  assert.ok(d.events.includes("screen-released"), "the view was never stopped");
  assert.ok(d.rawAtExit(), "the process never exited");
});

test("THE TERMINAL IS OUT OF RAW MODE BEFORE THE PROCESS EXITS", async () => {
  const d = daemon();
  await d.shutdown("SIGINT");
  assert.equal(d.rawAtExit(), "exit(rawMode=false)",
    "the daemon exited with the operator's terminal still in raw mode: no echo, listener attached");
});

test("...even when stopping the plugins takes real time", async () => {
  // The case that made it a live defect rather than a theoretical one. Any host running the
  // aify-comms plugin does real IO here; the review measured a 20ms fetch losing the restore every
  // time.
  const d = daemon({ pluginStopDelayMs: 25 });
  await d.shutdown("SIGINT");
  assert.equal(d.rawAtExit(), "exit(rawMode=false)");
  assert.deepEqual(
    d.events.filter((e) => e !== "plugins-stopped"),
    ["screen-released", "exit(rawMode=false)"],
    "the screen was not released before the exit",
  );
});

test("THE SECOND Ctrl+C ALSO LEAVES A USABLE TERMINAL", async () => {
  // `shutdown.mjs` designs for the double-Ctrl+C reflex explicitly: the second signal exits without
  // waiting. It must not be able to exit into a terminal the first signal had not yet handed back.
  const d = daemon({ pluginStopDelayMs: 50 });
  const first = d.shutdown("SIGINT");
  await d.shutdown("SIGINT");
  await first;
  for (const event of d.events.filter((e) => e.startsWith("exit("))) {
    assert.equal(event, "exit(rawMode=false)", "a second Ctrl+C exited into a raw-mode terminal");
  }
});

test("the screen is released before the plugins are asked to stop", async () => {
  // Stated as an ordering rather than only as an outcome, because the outcome is reachable by
  // accident on a fast host. What must hold is that nothing awaitable sits between the signal and
  // the operator getting their terminal back.
  const d = daemon({ pluginStopDelayMs: 10 });
  await d.shutdown("SIGTERM");
  // `shutdown` does not await `beforeStop`, so the delayed plugin stop has not landed yet -- which
  // is the very property under test. Wait for it before comparing, or this asserts against an event
  // that is simply not there and passes for the wrong reason in one direction and fails in the
  // other. (It failed: caught on the first run of this file.)
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(d.events.includes("plugins-stopped"), "the plugin stop never completed");
  assert.ok(
    d.events.indexOf("screen-released") < d.events.indexOf("plugins-stopped"),
    "an await was allowed to sit in front of the terminal restore",
  );
});
