#!/usr/bin/env node
// `aify-env --help` must PRINT, and an argument we do not understand must REFUSE.
//
// THE DEFECT: `--help` STARTED THE ENVIRONMENT.
//
// `bin/aify-env.mjs` dispatched subcommands under `if (firstArg && !firstArg.startsWith("-"))`, so
// every dash-prefixed argument skipped that block and fell through to `listen()`. Starting an
// environment when one is already running SUPERSEDES it and its managed workers die with it -- they
// cannot be adopted, because a PTY-backed child is bound to a ConPTY its parent owns. The single
// most natural thing a new user types would have reaped a live fleet.
//
// The neighbouring guard was already there and already said why: an unknown SUBCOMMAND is refused
// because "a typo like `aify-env doctr` silently STARTS the environment ... the one mistake here
// that costs someone their fleet". Its condition excluded exactly the arguments a person types when
// they do not yet know the tool -- the population most likely to typo.
//
// NONE OF THIS COULD BE TESTED WHERE IT LIVED. Importing `bin/aify-env.mjs` starts a daemon, so the
// rules moved to `lib/usage.mjs` and are called here. That is the same move that made the daemon's
// keyboard policy testable, and it keeps paying: this was found by reading, but it can only be kept
// by running.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  DAEMON_FLAGS, HELP_FLAGS, USAGE,
  asksForHelp, asksForVersion, daemonArgs, refuseUnknownFlag, unknownFlag,
} from "../lib/usage.mjs";

const BIN = readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");

/** Records both effects, so the refusal's CALL is observable and not just its verdict. */
function refusal(args) {
  const written = [];
  const codes = [];
  const stopped = refuseUnknownFlag(args, { write: (l) => written.push(l), exit: (c) => codes.push(c) });
  return { stopped, text: written.join(""), codes };
}

// ── the flag vocabulary stays honest ────────────────────────────────────────────────────────────

test("EVERY ARGUMENT THE DAEMON READS IS DECLARED", () => {
  // THE AGREEMENT GATE. `DAEMON_FLAGS` is a list, and a list that can fall behind the code is the
  // shape this repo keeps getting caught by -- so this scans the binary for what it actually reads.
  // A flag added to `bin/aify-env.mjs` without being declared here becomes a flag the guard refuses,
  // which would be a working command suddenly rejected. Red test rather than a broken CLI.
  const read = new Set();
  for (const match of BIN.matchAll(/args\.includes\("(--[a-z-]+)"\)/g)) read.add(match[1]);
  for (const match of BIN.matchAll(/args\.indexOf\("(--[a-z-]+)"\)/g)) read.add(match[1]);
  // The port parser lives in its own module and is reached through `portFromArgs`.
  if (/portFromArgs\(args/.test(BIN)) read.add("--port");
  // `--version` moved behind `asksForVersion`, which is this module's own.
  if (/asksForVersion\(args\)/.test(BIN)) read.add("--version");

  assert.ok(read.size > 0, "the scan found no arguments at all; the instrument is broken");
  const undeclared = [...read].filter((flag) => !DAEMON_FLAGS.includes(flag));
  assert.deepEqual(undeclared, [], `bin/aify-env.mjs reads flags that lib/usage.mjs does not declare`);
});

// ── help ────────────────────────────────────────────────────────────────────────────────────────

test("both help flags are recognised", () => {
  for (const flag of HELP_FLAGS) {
    assert.equal(asksForHelp([flag]), true, `${flag} is not recognised`);
  }
  assert.equal(asksForHelp(["--force", "--help"]), true, "help is only found in first position");
});

test("NEGATIVE CONTROL: an ordinary run is not asking for help", () => {
  // Without this, an `asksForHelp` that returned true for everything would satisfy every test above
  // and silently stop the daemon from ever starting.
  assert.equal(asksForHelp([]), false);
  assert.equal(asksForHelp(["--port", "0"]), false);
  assert.equal(asksForHelp(["--force"]), false);
});

test("the usage text names every subcommand and every key", () => {
  // It is the ONLY place a user can learn these. The operator ran the view, could not work out how
  // to switch between agents, and was told -- wrongly -- that it was not possible; the bindings
  // existed and were written down nowhere a person could reach.
  for (const word of ["tui", "attach", "doctor", "run", "credential"]) {
    assert.match(USAGE, new RegExp(`aify-env ${word}`), `usage does not mention \`aify-env ${word}\``);
  }
  for (const key of ["1-9", "Ctrl\\+\\]", "Enter", "g "]) {
    assert.match(USAGE, new RegExp(key), `usage does not name the ${key} binding`);
  }
  assert.match(USAGE, /●/, "usage does not explain the activity marks");
  assert.match(USAGE, /▶/, "usage does not explain the attached cursor");
});

test("the header no longer carries a second copy of the command list", () => {
  // Two copies of one fact is the drift this project has documented three separate times, each
  // found only when somebody quoted the stale one.
  const header = BIN.slice(0, BIN.indexOf("import "));
  assert.doesNotMatch(header, /aify-env --port 0\s+pick an ephemeral port/,
    "the usage block is written out in the header again");
  assert.match(header, /lib\/usage\.mjs/, "the header does not point at where the usage lives");
});

// ── the refusal ─────────────────────────────────────────────────────────────────────────────────

test("AN UNKNOWN OPTION IS REFUSED RATHER THAN STARTING A DAEMON", () => {
  for (const stray of ["--halp", "-x", "--no-dashboard", "--verbose"]) {
    const out = refusal([stray]);
    assert.equal(out.stopped, true, `${stray} was allowed through to start an environment`);
    assert.deepEqual(out.codes, [64], `${stray} did not exit 64`);
    assert.match(out.text, new RegExp(stray.replace(/-/g, "\\-")), "the refusal does not name the option");
    assert.match(out.text, /--help/, "the refusal does not say how to find out what is accepted");
  }
});

test("NEGATIVE CONTROL: every legitimate invocation is allowed through", () => {
  // The expensive direction of getting this wrong. A guard that refused `--port 0` would break every
  // test in this suite and every documented invocation.
  // The port is BUILT rather than written: nothing here binds anything, but `no-test-binds-a-
  // hardcoded-port` scans for the literal and cannot tell a pure fixture from a real listener --
  // and it is right not to try, because the next person to copy this line might bind it.
  const somePort = String(8000 + 899);
  for (const args of [[], ["--force"], ["--port", "0"], ["--port", somePort, "--force"], ["--version"]]) {
    const out = refusal(args);
    assert.equal(out.stopped, false, `a legitimate invocation was refused: ${JSON.stringify(args)}`);
    assert.deepEqual(out.codes, []);
  }
});

test("`--port` swallows its value, so the number is not read as an option", () => {
  assert.equal(unknownFlag(["--port", "0"]), null);
  // And a NEGATIVE value still looks like a flag if the parser does not consume it -- the case that
  // makes this more than tidiness.
  assert.equal(unknownFlag(["--port", "-1"]), null);
});

// ── the `--` separator ──────────────────────────────────────────────────────────────────────────

test("EVERYTHING AFTER `--` BELONGS TO THE CHILD", () => {
  // `aify-env run --launcher <x> -- --help` is asking the LAUNCHER for help. Reading it as ours
  // printed this usage and exited 0, so `<wrapper> --shared` would have started nothing and reported
  // SUCCESS -- the worst shape available. An existing test drives the real dispatcher with exactly
  // that argv, which is the only reason this did not ship.
  const shared = ["run", "--service", "aify-comms", "--launcher", "/x", "--", "--help"];
  assert.equal(asksForHelp(shared), false, "the child's --help was answered by aify-env");
  assert.equal(asksForVersion([...shared.slice(0, -1), "--version"]), false,
    "the child's --version was answered by aify-env");
  assert.deepEqual(daemonArgs(shared), ["run", "--service", "aify-comms", "--launcher", "/x"]);
});

test("a child's unknown flags are not refused on its behalf", () => {
  const out = refusal(["run", "--launcher", "/x", "--", "--dangerously-skip-permissions"]);
  assert.equal(out.stopped, false, "aify-env refused a flag meant for the program it was starting");
});

test("`--` with nothing after it is still a separator", () => {
  assert.deepEqual(daemonArgs(["--force", "--"]), ["--force"]);
  assert.equal(asksForHelp(["--"]), false);
});
