#!/usr/bin/env node
// `--port` is read and judged before anything tries to listen on it.
//
// EXTERNAL REVIEW, Round 8 (LOW): `--port` with nothing after it reached `listen()` as NaN and died
// with an uncaught ERR_SOCKET_BAD_PORT -- a stack trace for a typo, from a daemon whose whole job is
// to be running.
//
// TESTABLE ONLY BECAUSE IT MOVED. This lived in `bin/aify-env.mjs`, and importing that file STARTS A
// DAEMON -- a fact this project learned by killing five live agents. So every case below could once
// only be checked by launching a process and reading its stderr, which is why the crash survived to
// be found by a reviewer rather than by a test.
//
// AND THE FIRST VERSION OF THE GUARD CRASHED IN ITS OWN RIGHT, in the entry point, because it named
// a constant declared further down the module: a temporal dead zone, so the guard threw a
// ReferenceError instead of printing its message -- the same crash it exists to replace. Found by
// RUNNING it. That is the other half of the argument for this module: a pure function has no
// evaluation order to get wrong.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PORT, portFromArgs } from "../lib/port-argument.mjs";

test("no --port means the default", () => {
  assert.deepEqual(portFromArgs([]), { port: DEFAULT_PORT });
  assert.deepEqual(portFromArgs(["--force"]), { port: DEFAULT_PORT });
});

test("a real port is taken", () => {
  assert.deepEqual(portFromArgs(["--port", "9001"]), { port: 9001 });
});

test("PORT 0 IS LEGAL, and this is the case the guard must not eat", () => {
  // Every test in this suite starts the daemon with `--port 0` to ask the OS for a free one. A guard
  // written as `!parsed` would refuse exactly that, and the failure would look like the suite being
  // broken rather than the guard being wrong.
  assert.deepEqual(portFromArgs(["--port", "0"]), { port: 0 });
});

test("--port WITH NOTHING AFTER IT is refused, not passed on as NaN", () => {
  const answer = portFromArgs(["--port"]);
  assert.ok(answer.error, "a missing value produced a port. It reaches listen() as NaN and the "
    + "daemon dies with an uncaught ERR_SOCKET_BAD_PORT -- a stack trace for a typo.");
  assert.match(answer.error, /was given none/, "the message must say what is actually wrong");
});

test("a value that is not a port is refused, and quoted back", () => {
  for (const bad of ["abc", "-1", "65536", "80.5", "8 0"]) {
    const answer = portFromArgs(["--port", bad]);
    assert.ok(answer.error, `"${bad}" was accepted as a port`);
    assert.match(answer.error, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the refusal must quote what was given, or an operator cannot see their typo");
  }
});

test("`--port` as the LAST argument of several is still seen", () => {
  // The flag is found by index, so a value that happens to be another flag must not be swallowed as
  // a port -- and a missing value at the end of the list is the ordinary shape of this typo.
  assert.ok(portFromArgs(["--force", "--port"]).error, "a trailing --port was not caught");
  assert.ok(portFromArgs(["--port", "--force"]).error,
    "the next FLAG was accepted as a port value");
});
