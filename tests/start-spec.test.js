// Turning "run this launcher" into something the Runner can start, and the four ways it refuses.
//
// THESE ARE THE PATHS NOTHING ROUTINE REACHES. A launcher that cannot be read, one the allowlist
// refuses, and one with no interpreter on this host each happen only when something is already
// wrong -- so they are exercised here or nowhere. Each sends an operator somewhere completely
// different, which is the whole reason they are not one message: "the agent did not start", arriving
// minutes later from the component that could no longer say why, is what they replaced.
//
// ONE BUILDER, TWO CALLERS. The HTTP endpoint and the in-process service plugin both use this. Two
// copies would agree until one was fixed, and the half that rots is the one nobody runs by hand --
// this project has paid for that shape twice, with wrapper templates and with a doctor check
// implemented in two tiers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStartSpec } from "../lib/start-spec.mjs";

const NEWLINE = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

/** A launcher the allowlist accepts: a shebang, and the marker that IS the enrolment. */
const GOOD_LAUNCHER = [
  "#!/usr/bin/env bash",
  'HARNESS_WRAPPER_VERSION="1.2.3"',
  'exec claude "$@"',
  "",
].join(NEWLINE);

const fs = (text) => ({ readFile: () => text, platform: "linux" });

const ASK = { service: "aify-comms", launcher: "/opt/launchers/claude-aify", args: ["--managed"] };

test("a good launcher becomes a spec the Runner can start", () => {
  const { spec, error } = buildStartSpec(ASK, fs(GOOD_LAUNCHER));
  assert.equal(error, undefined);
  assert.equal(spec.service, "aify-comms");
  assert.equal(spec.fileText, GOOD_LAUNCHER, "the Runner re-judges the text it was given");
  assert.ok(spec.command, "a spec with no command cannot be spawned");
  assert.ok(Array.isArray(spec.args));
});

test("the launcher path survives beside the command that will run it", () => {
  // `command` is the INTERPRETER for a shebang launcher -- `bash` -- a name shared with every other
  // bash-launched process on the host. The reaper verifies a recorded pid by asking whether the live
  // command line contains this string, so the launcher path is the discriminating half. After pid
  // reuse, a stranger's bash once matched and was killed with its whole tree.
  const { spec } = buildStartSpec(ASK, fs(GOOD_LAUNCHER));
  assert.equal(spec.launcher, ASK.launcher);
  // THE INVARIANT IS THAT IT IS IDENTIFIABLE IN THE SPAWNED COMMAND LINE, not that it sits in argv.
  // POSIX spawns the launcher directly, so it IS the command; Windows spawns `bash <launcher>`, so
  // it is an argument. Asserting the Windows shape everywhere is what this test did first, and it
  // failed on the platform where the launcher is the command -- the more direct of the two.
  const commandLine = [spec.command, ...spec.args].map(String).join(" ");
  assert.ok(commandLine.includes("claude-aify"),
    `the launcher is not identifiable in "${commandLine}", so the reaper cannot verify a recorded pid `
    + "against the process we actually started");
});

test("the caller's own args are carried through", () => {
  const { spec } = buildStartSpec(ASK, fs(GOOD_LAUNCHER));
  assert.ok(spec.args.includes("--managed"), "argv never reaching the spawn is a defect this has had");
});

test("a launcher that cannot be read FAILS CLOSED", () => {
  // "I could not open it" must never become "go ahead".
  const { spec, error } = buildStartSpec(ASK, {
    readFile: () => { const e = new Error("nope"); e.code = "ENOENT"; throw e; },
    platform: "linux",
  });
  assert.equal(spec, undefined);
  assert.equal(error.status, 403);
  assert.match(error.detail, /cannot read .*ENOENT/);
});

test("a launcher with no shebang is refused, with the reason", () => {
  const { error } = buildStartSpec(ASK, fs('HARNESS_WRAPPER_VERSION="1.0.0"' + NEWLINE));
  assert.equal(error.status, 403);
  assert.match(error.detail, /shebang/);
});

test("a launcher with no harness marker is refused", () => {
  // Enrolment is by CARRYING THE CONTRACT, not by being named in a list -- so a file that merely
  // looks like a script is not one this host will run.
  const { error } = buildStartSpec(ASK, fs("#!/usr/bin/env bash" + NEWLINE + "echo hi" + NEWLINE));
  assert.equal(error.status, 403);
  assert.match(error.detail, /HARNESS_WRAPPER_VERSION/);
});

test("an empty or binary file is refused before anything reads meaning into it", () => {
  assert.match(buildStartSpec(ASK, fs("")).error.detail, /empty/);
  assert.match(buildStartSpec(ASK, fs("#!/bin/sh" + String.fromCharCode(0) + "x")).error.detail, /binary/);
});

test("a request naming no service or no launcher is refused before any file is touched", () => {
  let read = 0;
  const counting = { readFile: () => { read += 1; return GOOD_LAUNCHER; }, platform: "linux" };
  assert.equal(buildStartSpec({ launcher: "x" }, counting).error.status, 400);
  assert.equal(buildStartSpec({ service: "s" }, counting).error.status, 400);
  assert.equal(read, 0, "a malformed request must not reach the filesystem at all");
});

test("on Windows a command that is not a path is refused with what to do about it", () => {
  // node-pty says `File not found:` and that arrived as a 500 with nothing naming the cause. An
  // operator on a plain cmd prompt hit exactly this: no Git on PATH, the remaining bashes are WSL
  // doorways and correctly skipped, and the resolver fell back to the bare name.
  const { error } = buildStartSpec(ASK, { readFile: () => GOOD_LAUNCHER, platform: "win32" });
  if (error) {
    assert.equal(error.status, 422);
    assert.match(error.detail, /not a path|Git for Windows/);
  } else {
    // A host WITH a usable bash resolves to a real path, which is the correct outcome and not a
    // failure of this test -- so assert that instead of pretending the refusal is unconditional.
    const { spec } = buildStartSpec(ASK, { readFile: () => GOOD_LAUNCHER, platform: "win32" });
    assert.ok(spec.command.includes("/") || spec.command.includes(BACKSLASH),
      `resolved to "${spec.command}", which is neither a path nor a refusal`);
  }
});

test("cwd and env are passed only when they are the right shape", () => {
  const withBad = buildStartSpec({ ...ASK, cwd: 42, env: ["not", "an", "object"] }, fs(GOOD_LAUNCHER));
  assert.equal(withBad.spec.cwd, undefined);
  assert.equal(withBad.spec.env, undefined, "an array is not an environment");
  const withGood = buildStartSpec({ ...ASK, cwd: "/work", env: { A: "1" } }, fs(GOOD_LAUNCHER));
  assert.equal(withGood.spec.cwd, "/work");
  assert.deepEqual(withGood.spec.env, { A: "1" });
});

test("the label is the caller's own name for the work, and nothing reads meaning into it", () => {
  const { spec } = buildStartSpec({ ...ASK, label: "sc-lead" }, fs(GOOD_LAUNCHER));
  assert.equal(spec.label, "sc-lead");
  assert.equal(buildStartSpec({ ...ASK, label: 7 }, fs(GOOD_LAUNCHER)).spec.label, "");
});
