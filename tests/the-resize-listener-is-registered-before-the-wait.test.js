#!/usr/bin/env node
// The view's resize listener must be registered BEFORE the await that never resolves.
//
// IT WAS NOT, and the line shipped dead on 2026-09-07. `bin/aify-env-tui.mjs` holds the process open
// with `await new Promise(() => {})` -- deliberately, because the exits are onQuit, the two signal
// handlers and the daemon's death, so nothing resolves it. The resize registration sat AFTER that
// line. The terminal could be resized all day and nothing was ever called.
//
// REVIEW MEASURED IT by executing the exact binary with fake terminal dependencies: `started=1`,
// `keepalives=1`, `resizeListeners=0`, and no resize calls. Moving the identical registration above
// the await yielded one listener and a resize for 80x20.
//
// WHY NO EXISTING TEST SAW IT. The dashboard and daemon tests drive `lib/`; nothing drives this
// entrypoint, because importing it starts a view that talks to a daemon. So the whole file is a place
// where dead code passes a green suite, and this test exists to make that specific shape impossible.
//
// A SOURCE-ORDER ASSERTION, and that is a compromise I would rather name than hide. This repo's own
// rule is that a source regex proves a line was WRITTEN, not that it RUNS -- which is exactly the
// defect here, so the usual objection cuts the other way: the bug was an ordering fact about the
// source, and ordering is what this measures. Both anchors must be found, so the test cannot quietly
// stop measuring if either is renamed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env-tui.mjs",
);
const SOURCE = readFileSync(ENTRYPOINT, "utf8");

//: The await that never resolves. Anything after it in this file is unreachable.
const FOREVER = 'await new Promise(() => {});';
//: The registration whose whole job is to still be listening while that await holds.
const REGISTRATION = 'process.stdout.on("resize"';

test("POSITIVE CONTROL: both anchors are present, so this test is measuring something", () => {
  // If either is renamed, the ordering assertion below would pass on an empty comparison. That is the
  // failure mode of every source-shaped test, and it is the one worth guarding here.
  assert.ok(SOURCE.includes(FOREVER), `${ENTRYPOINT} no longer contains ${FOREVER}`);
  assert.ok(SOURCE.includes(REGISTRATION), `${ENTRYPOINT} no longer registers a resize listener`);
});

test("THE LISTENER IS REGISTERED BEFORE THE WAIT, not after it", () => {
  const registered = SOURCE.indexOf(REGISTRATION);
  const waits = SOURCE.indexOf(FOREVER);
  assert.ok(
    registered < waits,
    "the resize listener is registered AFTER an await that never resolves, so it never runs -- the "
    + `registration is at character ${registered} and the wait at ${waits}. Move it above.`,
  );
});

test("there is exactly ONE never-resolving await, so 'before it' is unambiguous", () => {
  // Two of them and the ordering above could be true of the wrong one.
  const occurrences = SOURCE.split(FOREVER).length - 1;
  assert.equal(occurrences, 1, `expected one ${FOREVER}, found ${occurrences}`);
});
