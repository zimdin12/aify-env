// The daemon's own messages reach the screen as a section, not as debris across a frame.
//
// THE OPERATOR'S REPORT, 2026-09-04, from their own terminal. Three lines reading
// `[aify-env] terminal term_1788413603585_300f67a3 output not delivered: fetch failed` were wedged
// into the view -- one above the SERVICES table, one below it, one above the PROCESSES heading --
// with the layout coming apart around them.
//
// THE CAUSE IS TWO WRITERS ON ONE TERMINAL. `bin/aify-env.mjs` gave the plugin host a log sink that
// wrote to stderr; `dashboard.mjs` writes frames to stdout. `frameUpdate` is DIFFERENTIAL: it
// repaints only changed rows, addressed by cursor position. A stray line shifts every row below it,
// so the writer's model of the screen stops matching the screen and every later frame paints in the
// wrong place. The messages were not the bug; writing them to a screen somebody else was addressing
// was.
//
// AND SILENCING THEM WOULD HAVE BEEN THE WRONG FIX. "output not delivered: fetch failed" is this
// environment reporting that it could not hand a running agent's console to the service. That is
// what a dashboard is for. So they are kept, counted, and rendered.
//
// THE JOIN IS TESTED, NOT JUST THE HALVES. A1 and A2 both worked while their joins were unpinned --
// a renderer proven against a hand-made snapshot, a collector proven in isolation, and nothing
// asserting the first ever received what the second produced. So the middle test here drives
// `collectSnapshot` with a real notices ring and renders what comes back.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { collectSnapshot, startDashboard } from "../lib/dashboard.mjs";
import { createNotices } from "../lib/notices.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const FETCH_FAILED = "terminal term_1788413603585_300f67a3 output not delivered: fetch failed";
const NOWHERE = "http://127.0.0.2:1";

/** A clock the test drives, for the same reason the renderer takes `nowMs`. */
function fixedClock(startMs) {
  let at = startMs;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("THE RING KEEPS A MESSAGE AND STAMPS IT", () => {
  const clock = fixedClock(1_000_000);
  const notices = createNotices({ now: clock.now });
  notices.add(FETCH_FAILED);
  const [only] = notices.recent();
  assert.equal(only.text, FETCH_FAILED);
  assert.equal(only.count, 1);
  assert.equal(only.atMs, 1_000_000);
});

test("A REPEAT IS COUNTED, not stacked into another row", () => {
  // The failure that prompted this repeats every poll. Fifty identical rows would push the
  // processes off the screen and say nothing a count does not.
  const clock = fixedClock(0);
  const notices = createNotices({ now: clock.now });
  for (let i = 0; i < 37; i += 1) {
    clock.advance(2000);
    notices.add(FETCH_FAILED);
  }
  const rows = notices.recent();
  assert.equal(rows.length, 1, "a repeated message added rows");
  assert.equal(rows[0].count, 37);
  assert.equal(rows[0].atMs, 74_000, "the stamp is the LAST occurrence, not the first");
});

test("a DIFFERENT message opens a new row", () => {
  const notices = createNotices({ now: () => 5 });
  notices.add(FETCH_FAILED);
  notices.add("credential refused");
  assert.deepEqual(notices.recent().map((n) => n.text), [FETCH_FAILED, "credential refused"]);
});

test("IT IS BOUNDED, because this runs for the life of the daemon", () => {
  // The condition that produces these messages fastest is the one that would make an unbounded
  // buffer grow fastest.
  const notices = createNotices({ limit: 3, now: () => 0 });
  for (const n of [1, 2, 3, 4, 5]) notices.add(`message ${n}`);
  assert.deepEqual(notices.recent().map((n) => n.text), ["message 3", "message 4", "message 5"]);
});

test("blank messages are not rows", () => {
  const notices = createNotices({ now: () => 0 });
  notices.add("");
  notices.add("   ");
  notices.add(null);
  assert.equal(notices.size, 0);
});

test("THE MESSAGE THE OPERATOR SAW REACHES THE VIEW, driven through startDashboard", async () => {
  // THE JOIN, and the first version of this test did NOT test it. It called `collectSnapshot` and
  // then attached `snapshot.notices` BY HAND before rendering -- so deleting the line in
  // `dashboard.mjs` that actually attaches them left this green. A mutation caught it, which is the
  // same defect A1 and A2 shipped with and the same one this file's header claims to avoid.
  //
  // The attachment happens inside `startDashboard`'s draw, so that is what has to run. `once` plus a
  // captured `write` gives one real frame with no timer and no terminal.
  const clock = fixedClock(1_000_000);
  const notices = createNotices({ now: clock.now });
  notices.add(FETCH_FAILED);
  notices.add(FETCH_FAILED);

  let painted = "";
  await startDashboard({
    endpoint: NOWHERE,
    registryPath: "/aify-tests/no-such-registry.json",
    fetchImpl: async () => { throw new Error("nothing is listening"); },
    write: (text) => { painted += text; },
    clearScreen: false,
    once: true,
    columns: 140,
    color: false,
    notices,
  });

  assert.match(painted, /NOTICES/, "the section never reached a frame");
  assert.match(painted, /output not delivered/, "the operator's message never reached the screen");
  assert.match(painted, /x2/, "the repeat count is missing");
});

test("A QUIET ENVIRONMENT SHOWS NO SECTION AT ALL", async () => {
  // Same rule RECENT EXITS follows. An empty NOTICES heading is furniture, and this panel is read
  // at a glance.
  const snapshot = await collectSnapshot({
    endpoint: NOWHERE,
    registryPath: "/aify-tests/no-such-registry.json",
    fetchImpl: async () => { throw new Error("nothing is listening"); },
  });
  const out = renderDashboard(snapshot, { columns: 140, color: false }).join("\n");
  assert.ok(!/NOTICES/.test(out), "an empty notices list drew a heading");
});

test("THE VIEW STILL RENDERS EVERYTHING ELSE, which is the control", async () => {
  // If the section had been added in a way that broke the layout, every assertion above could pass
  // while the panel it lives on came apart -- which is the failure being fixed.
  const notices = createNotices({ now: () => 0 });
  notices.add(FETCH_FAILED);
  const snapshot = await collectSnapshot({
    endpoint: NOWHERE,
    registryPath: "/aify-tests/no-such-registry.json",
    fetchImpl: async () => { throw new Error("nothing is listening"); },
  });
  snapshot.notices = notices.recent();
  const out = renderDashboard(snapshot, { columns: 140, color: false }).join("\n");
  for (const section of ["SERVICES", "HEALTH", "PROCESSES", "NOTICES", "TRAFFIC"]) {
    assert.match(out, new RegExp(section), `${section} is missing`);
  }
});

test("THE SINK IS ROUTED, NOT DUPLICATED: the daemon writes stderr only when it owns no screen", () => {
  // A SOURCE ASSERTION, deliberately, and the weaker instrument. Driving it for real means starting
  // the daemon, and starting shared infrastructure to test it has cost this project a live fleet
  // twice. What this pins is the shape the defect had: the plugin log sink must not be a bare
  // stderr write, and the redirect must key on the view HAVING STARTED rather than on the intent to
  // start it -- a dashboard that threw would otherwise swallow every message into a ring nobody
  // renders.
  const src = readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  assert.match(src, /log: \(message\) => logLine\(message\)/,
    "the plugin log sink writes somewhere other than the routed one");
  assert.match(src, /if \(dashboardOwnsScreen\) \{\s*\n\s*NOTICES\.add\(message\);/,
    "logLine no longer routes into the notices ring");
  assert.match(src, /dashboardOwnsScreen = true;/, "nothing marks the view as owning the screen");
  assert.match(src, /notices: NOTICES,/, "the view is never given the ring");
});
