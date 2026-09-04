#!/usr/bin/env node
// `aify-env tui` must keep running until the operator leaves it.
//
// EXTERNAL REVIEW, Round 8 H7. `startDashboard` resolves once the FIRST FRAME is painted -- it hands
// back a handle, it does not wait for the screen to be finished with. So `aify-env-tui.mjs`'s
// top-level await completed immediately, and both callers read that as the view being done: the
// dispatcher does `await import(target); process.exit(...)`, and the refused-takeover branch does
// the same and even comments "reached only if it returns". It returned instantly.
//
// WHY IT SURVIVED: running the file DIRECTLY kept working, because nothing exited on its behalf.
// Only the dispatcher path -- which is what `aify-env tui` actually is -- exited after one frame. So
// the obvious way to test it by hand was the one way that looked fine.
//
// THE SECOND EXIT, found while fixing the first: with only a never-resolving promise, node found an
// empty event loop with a pending top-level await and exited 13 in under a second. `lib/dashboard`
// UNREFS its refresh timer on purpose -- inside the daemon the view is a passenger -- so the
// standalone process has to hold the loop itself. A fix that swapped one silent early exit for
// another is exactly what this file must be able to tell apart, so it asserts DURATION, not status.
//
// SEALED: an endpoint that answers nowhere and a registry that does not exist. This view is
// read-only, but a test that pointed it at the live daemon would be one line from watching the
// operator's fleet, and every seal in this suite exists because that line was written once.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "bin", "aify-env.mjs");

const SEALED = {
  AIFY_ENV_ENDPOINT: "http://127.0.0.2:1",
  AIFY_SERVICE_REGISTRY: "/aify-sealed-in-tests/does-not-exist.json",
  AIFY_TUI_REFRESH_MS: "300",
  AIFY_PROBE_TIMEOUT_MS: "300",
  AIFY_AGENTS_TIMEOUT_MS: "300",
  NO_COLOR: "1",
};

/**
 * Run `aify-env <args>` for `ms`, then report whether it was STILL RUNNING when time ran out.
 *
 * Duration, not exit status, because both bugs here exit quickly with a plausible-looking status --
 * 0 from the dispatcher, 13 from an unsettled top-level await. "It exited on its own" is the defect
 * in both cases, whatever number came with it.
 */
function stillRunningAfter(args, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, ...SEALED },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let exited = null;
    child.on("exit", (code, signal) => { exited = { code, signal }; });
    setTimeout(() => {
      const alive = exited === null;
      try { child.kill(); } catch { /* already gone */ }
      resolve({ alive, exited });
    }, ms);
  });
}

test("`aify-env tui` is still on screen seconds later", async () => {
  const { alive, exited } = await stillRunningAfter(["tui"], 4000);
  assert.ok(
    alive,
    `the view exited on its own after ${JSON.stringify(exited)}. An operator who ran this to watch `
    + "an environment gets one frame and their prompt back -- and if they were watching for the "
    + "moment something recovers, they are told nothing and see nothing.",
  );
});

test("`--once` still renders one frame and leaves", async () => {
  // THE CONTROL, and it is not optional: the test above is satisfied by a view that hangs in EVERY
  // mode, which would break the scripted and test paths `--once` exists for. One assertion needs the
  // other to mean anything.
  const { alive, exited } = await stillRunningAfter(["tui", "--once"], 4000);
  assert.ok(!alive, "`--once` did not exit; a script or a test asking for one frame now hangs");
  assert.equal(
    exited?.code, 0,
    `\`--once\` exited ${JSON.stringify(exited)}. Code 13 is node's unsettled top-level await, which `
    + "is how the first version of this fix failed -- one silent early exit swapped for another.",
  );
});

// ── a refused takeover describes nothing ─────────────────────────────────────────────────────────
//
// EXTERNAL REVIEW, Round 8 M15, and its own note is why it lands with the H7 fix rather than after
// it: "masked today by H7". The advertise block is at MODULE SCOPE and the refused-takeover branch
// lives inside `server.on("error", ...)` -- an event handler -- so module evaluation never waited for
// it. A process that refused to take over and opened a read-only view kept posting this host's
// runtimes, terminal and pty support on a timer, from a process hosting NOTHING.
//
// The service stands its own bridge down when aify-env advertises, so that advertisement claims
// capabilities nobody will deliver and the spawn that follows fails with no cause attached. Before
// H7 it lasted a second, because the view exited after one frame. Now it lasts as long as somebody
// watches, which is the whole point of the H7 fix.
//
// READ AS SOURCE, and the reason is written down rather than assumed: reaching the branch for real
// needs a LIVE daemon on the port to refuse a takeover FROM, and starting shared infrastructure to
// test it has cost this project a live fleet twice. Both halves are checked, because either alone
// leaves the race the fix exists to close.

test("the refusal path stops this process describing the host", () => {
  const entry = readFileSync(ENTRY, "utf8");
  assert.match(entry, /viewOnly = true;/,
    "the refused-takeover branch no longer marks this process as a view, so the advertise block "
    + "below it cannot tell that this host runs nothing");
  assert.match(entry, /if \(stopAdvertising\) \{ stopAdvertising\(\); stopAdvertising = null; \}/,
    "the refusal no longer stops an advertise timer that was ALREADY armed. Module evaluation does "
    + "not wait for an event handler, so the flag alone covers only one of the two orders");
  assert.match(entry, /if \(!viewOnly\) \{/,
    "the advertise block no longer consults the view flag, so a refused takeover arms the timer "
    + "anyway and describes a host it does not run");
});
