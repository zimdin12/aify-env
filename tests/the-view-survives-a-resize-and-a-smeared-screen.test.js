#!/usr/bin/env node
// Two ways the screen and the frame's model of it drift apart, and the two recoveries.
//
// THE OPERATOR SAW IT, 2026-09-07: *"from left side i feel like 2 characters get cached and not
// written over with empty char when i scroll."*
//
// `frameUpdate` writes only rows that CHANGED against its own model of the screen, and writes each
// one followed by erase-to-end-of-line -- which is correct, and is why this is not a clipping bug.
// The model itself was the problem, in two ways:
//
//   1. THE SIZE WAS READ ONCE. `columns` and `rows` were captured at startup and never again, so a
//      resized window kept being painted at the old size. Wider rows leave a tail nothing erases;
//      narrower ones wrap, and a wrapped row shifts every row below it out from under the frame's
//      absolute addressing.
//   2. NOTHING COULD FORCE A REPAINT. Anything that disturbs the screen from outside this program --
//      scrolling back, another writer, a resize we did not hear about -- leaves rows the diff will
//      never rewrite, because as far as it knows they are already correct.
//
// Every terminal program binds Ctrl+L for the second. The first is the caller's to report, because
// this module deliberately never reads `process.stdout`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";

import { routeKey } from "../lib/keys.mjs";
import { startDaemonView } from "../lib/daemon-view.mjs";

const CTRL_L = String.fromCharCode(12);
const CTRL_C = String.fromCharCode(3);
const dash = (mode = "dashboard") => ({ mode, selected: 0, count: 3, query: "" });

// ── Ctrl+L ──────────────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: the dashboard still routes its ordinary keys", () => {
  // Every assertion below is "this key produces a repaint". A router that had stopped matching
  // anything would satisfy the pty pass-through case and report green.
  assert.equal(routeKey("q", dash()).action, "quit");
  assert.equal(routeKey(CTRL_C, dash()).action, "interrupt");
});

test("Ctrl+L asks for a repaint from the dashboard and from the picker", () => {
  assert.equal(routeKey(CTRL_L, dash()).action, "repaint");
  assert.equal(routeKey(CTRL_L, dash("picker")).action, "repaint");
});

test("a repaint does not move the selection or leave the mode", () => {
  const out = routeKey(CTRL_L, { mode: "picker", selected: 2, count: 4, query: "sc" });
  assert.equal(out.state.selected, 2);
  assert.equal(out.state.mode, "picker");
  assert.equal(out.state.query, "sc", "redrawing the screen threw away the search");
});

test("NEGATIVE CONTROL: inside a pane Ctrl+L belongs to the PROCESS", () => {
  // An agent clears its own screen with it. Intercepting it there would take a key the agent uses
  // away from the agent -- the same rule that keeps Ctrl+C passing through.
  const out = routeKey(CTRL_L, { mode: "pty", selected: 0, count: 3, query: "" });
  assert.equal(out.action, null);
  assert.equal(out.toPty, CTRL_L);
});

// ── resize ──────────────────────────────────────────────────────────────────────────────────────

/** A fake screen that can be resized, so no test depends on the real terminal. */
function screen({ columns = 100, rows = 24 } = {}) {
  const out = new EventEmitter();
  out.isTTY = true;
  out.columns = columns;
  out.rows = rows;
  out.resizeTo = (c, r) => { out.columns = c; out.rows = r; out.emit("resize"); };
  return out;
}

function spyView() {
  const calls = [];
  const resizes = [];
  return {
    calls,
    resizes,
    start: async (options) => {
      calls.push(options);
      return { stop: () => {}, resize: (size) => resizes.push(size) };
    },
  };
}

test("THE DAEMON'S VIEW HEARS ITS TERMINAL RESIZE", () => {
  // It never did. The size was read once at startup and the frame kept painting at it.
  const spy = spyView();
  const stdout = screen({ columns: 100, rows: 24 });
  return startDaemonView({
    endpoint: "e", registryPath: "r", stdout, stdin: { isTTY: true }, start: spy.start,
  }).then(() => {
    assert.equal(spy.calls[0].columns, 100, "the first frame was not drawn at the real width");
    stdout.resizeTo(180, 50);
    assert.deepEqual(spy.resizes, [{ columns: 180, rows: 50 }], "a resize reached nothing");
  });
});

test("a view that DECLINED to start registers no listener", async () => {
  // Piped output keeps the plain banner; wiring a resize there would be a listener on a stream
  // nobody is drawing to.
  const spy = spyView();
  const stdout = screen();
  stdout.isTTY = false;
  await startDaemonView({ endpoint: "e", registryPath: "r", stdout, stdin: { isTTY: true }, start: spy.start });
  assert.equal(stdout.listenerCount("resize"), 0);
});

test("a view whose start THREW registers no listener either", async () => {
  const stdout = screen();
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout, stdin: { isTTY: true },
    start: async () => { throw new Error("no tty"); },
    write: () => {},
  });
  assert.equal(stdout.listenerCount("resize"), 0, "a failed view left a listener behind");
});

test("an older view with no resize method does not throw on a resize", async () => {
  // `startDashboard` returns `{ stop }` alone for `--once`. A resize arriving at one of those must
  // be a no-op rather than an uncaught TypeError inside an event listener.
  const stdout = screen();
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout, stdin: { isTTY: true },
    start: async () => ({ stop: () => {} }),
  });
  stdout.resizeTo(80, 20);   // must not throw
  assert.ok(true);
});
