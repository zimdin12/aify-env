#!/usr/bin/env node
// What gets written into the process record has to name THIS process and no other.
//
// ENV-H2, external review round 7. `defaultVerify` decides whether a recorded pid may be killed by
// asking whether the live process's command line CONTAINS the recorded launcher. That is only a
// permission to kill if the recorded string is discriminating.
//
// IT WAS NOT, ON WINDOWS. A shebang launcher cannot be spawned by path there, so `interpreterFor`
// turns it into `bash.exe <launcher>` -- and the runner recorded `spec.command`, which is `bash.exe`.
// Every bash-launched process on the host carries that substring. Once a pid was recycled, a
// stranger's bash matched, and `taskkill /T` took its whole tree.
//
// POSIX spawns the launcher directly, so `command` and launcher were the same string and the bug
// could not appear. That is exactly why it survived: the platform that was wrong is the one whose
// spawn path is unusual.
//
// TWO ARMS, because they fail for different reasons and a fix to one does not imply the other:
//   * the route hands the runner the launcher it was asked to start, at all;
//   * verifying against the interpreter really does match a stranger, and against the launcher does
//     not -- with a control proving our OWN process still verifies, or the fix would simply have
//     disabled reaping.

import assert from "node:assert/strict";
import { test } from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultVerify } from "../lib/orphan-reap.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { readOwned } from "../lib/owned-processes.mjs";
import { Runner } from "../lib/runner.mjs";

// A launcher the allowlist accepts. The marker is what makes it a wrapper rather than a stray script.
const LAUNCHER_TEXT = [
  "#!/usr/bin/env bash",
  'HARNESS_WRAPPER_VERSION="0.6.0"',
  'exec claude "$@"',
  "",
].join(String.fromCharCode(10));

const LAUNCHER_PATH = "C:/Users/Administrator/.local/bin/claude-aify";

/** A runner stub that records the spec it was handed. */
function stubRunner() {
  const specs = [];
  return {
    specs,
    list: () => [],
    exits: () => [],
    start: async (spec) => {
      specs.push(spec);
      return { id: "p1", pid: 4242, terminal: false };
    },
  };
}

// -- arm one: the route passes the launcher through -----------------------------------------------

test("the route hands the runner the launcher it was asked to start", async () => {
  const runner = stubRunner();
  const response = await handleRequest(
    {
      method: "POST",
      path: "/processes",
      body: { service: "aify-comms", launcher: LAUNCHER_PATH, args: [], cwd: "/tmp" },
    },
    { runner, readFile: () => LAUNCHER_TEXT, version: "0.6.0" },
  );

  assert.ok(response.status < 300, `the start was refused (${response.status}), so this proves nothing`);
  assert.equal(runner.specs.length, 1, "the runner was never asked to start anything");
  assert.equal(
    runner.specs[0].launcher, LAUNCHER_PATH,
    "the runner is not told which launcher it is running, so it can only record the interpreter",
  );
});

test("and the runner writes THAT into the record, not the interpreter it spawned", async () => {
  // THE CALL SITE, not the value handed to it. Arm one proves the route passes a launcher; nothing
  // there proves the runner records it, and a helper proven in isolation still leaves its caller
  // unproven -- which is the shape this repo keeps rediscovering.
  //
  // `command` is deliberately the node binary here: it stands in for `bash.exe`, the interpreter that
  // actually runs the launcher on Windows. If the record names it, the record names something every
  // other node process on the host shares.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-launcher-record-"));
  const ownedFile = path.join(dir, "owned.json");
  const runner = new Runner({ openTerminal: null, ownedFile });

  await runner.start({
    service: "aify-comms",
    fileText: LAUNCHER_TEXT,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 50)"],
    launcher: LAUNCHER_PATH,
  });

  const [entry] = readOwned(ownedFile);
  assert.ok(entry, "nothing was recorded, so this test cannot see what was recorded");
  assert.equal(
    entry.launcher, LAUNCHER_PATH,
    `the record names ${entry.launcher}, which is the interpreter. Every process started by that same `
    + "interpreter matches it, so a recycled pid is a permission to kill a stranger",
  );
});

test("a caller that names no launcher still gets a record, and the old value", async () => {
  // The fallback, said out loud. An entry with an EMPTY launcher is never reaped at all
  // (see the last test in this file), so silently writing one would disable recovery rather than
  // narrow it -- trading a rare wrong kill for a permanent leak.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-launcher-fallback-"));
  const ownedFile = path.join(dir, "owned.json");
  const runner = new Runner({ openTerminal: null, ownedFile });

  await runner.start({
    service: "aify-comms",
    fileText: LAUNCHER_TEXT,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 50)"],
  });

  const [entry] = readOwned(ownedFile);
  assert.equal(entry.launcher, process.execPath, "a spec with no launcher recorded nothing to verify against");
});

// -- arm two: why recording the interpreter is a permission to kill strangers ----------------------

/** `defaultVerify` with a stubbed process probe, so this is decidable without spawning anything. */
const verifyAgainst = (launcher, commandLine) => defaultVerify(
  { pid: 4242, launcher },
  { platform: "win32", run: () => ({ stdout: commandLine }) },
);

// Someone else's bash. Nothing to do with us; it just happens to be bash, on a pid we once used.
const A_STRANGERS_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe /c/other/project/build.sh --watch';
// Our own process, spawned the way interpreterFor spawns a shebang launcher on Windows.
const OUR_OWN = `C:\\Program Files\\Git\\bin\\bash.exe ${LAUNCHER_PATH}`;

test("verifying against the interpreter matches a process that is not ours", () => {
  // THE DEFECT, stated as the fact it is. This is what the old record permitted.
  assert.equal(
    verifyAgainst("bash.exe", A_STRANGERS_BASH), true,
    "if this is false the hazard has changed shape and the rest of this file needs rereading",
  );
});

test("verifying against the launcher does not", () => {
  assert.equal(
    verifyAgainst(LAUNCHER_PATH, A_STRANGERS_BASH), false,
    "a stranger's bash matches our launcher path -- the recorded value is not discriminating",
  );
});

test("and our own process still verifies, so reaping is narrowed rather than disabled", () => {
  // POSITIVE CONTROL. Without this, "never matches anything" would pass the test above and quietly
  // turn the reaper off -- which is the failure the whole record exists to prevent.
  assert.equal(
    verifyAgainst(LAUNCHER_PATH, OUR_OWN), true,
    "our own process no longer verifies, so nothing will ever be reaped",
  );
});

test("separator spelling does not decide whether a process may be killed", () => {
  // The launcher is recorded with forward slashes and Windows reports backslashes. Both spellings are
  // correct, and `defaultVerify` normalises -- pinned because a regression here reads as "the reaper
  // stopped working" on one platform only.
  const backslashed = LAUNCHER_PATH.split("/").join(String.fromCharCode(92));
  assert.equal(verifyAgainst(LAUNCHER_PATH, `bash.exe ${backslashed}`), true);
});

test("an entry with no launcher is never reaped", () => {
  // NEGATIVE CONTROL on the probe itself, and the documented trade: a record written before launchers
  // were tracked cannot be verified, so it is left alone rather than guessed about.
  assert.equal(verifyAgainst("", OUR_OWN), false);
  assert.equal(defaultVerify({ pid: 1 }, { platform: "win32", run: () => ({ stdout: OUR_OWN }) }), false);
});
