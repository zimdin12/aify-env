#!/usr/bin/env node
// Which files on PATH could be aify launchers.
//
// THIS BLOCK HAD NO TEST UNTIL IT LEFT `bin/aify-env.mjs`, and could not have had one: importing
// that file STARTS a daemon that supersedes the operator's and reaps its managed workers. Every rule
// below was a comment nothing could execute.
//
// WHAT A WRONG ANSWER COSTS. `installedHarnesses` reads the marker inside each of these files to
// decide which runtimes this host can run, and that list is advertised to every registered service.
// A scan that quietly returns nothing does not fail -- it advertises a host with no runtimes, and
// spawns go elsewhere with nothing anywhere saying why. So an empty result is the dangerous answer,
// and every zero here is positive-controlled in the same run.

import assert from "node:assert/strict";
import test from "node:test";

import { aifyLauncherFilesOnPath } from "../lib/launcher-scan.mjs";

/** A fake filesystem: directory -> names, and file path -> text. */
function fakeFs(dirs, files = {}) {
  const reads = [];
  return {
    reads,
    readdir: (dir) => {
      if (!(dir in dirs)) throw new Error(`ENOENT: ${dir}`);
      return dirs[dir];
    },
    readFile: (file) => {
      reads.push(file);
      if (!(file in files)) throw new Error(`EACCES: ${file}`);
      return files[file];
    },
  };
}

test("POSITIVE CONTROL: a launcher on PATH is found, with its text", () => {
  const fs = fakeFs({ "/opt/bin": ["claude-aify", "ls"] }, { "/opt/bin/claude-aify": "# AIFY_RUNTIME=claude-code" });
  const found = aifyLauncherFilesOnPath({ env: { PATH: "/opt/bin" }, platform: "linux", ...fs });
  assert.deepEqual(found, [{ file: "/opt/bin/claude-aify", text: "# AIFY_RUNTIME=claude-code" }]);
});

test("ONLY NAMES THAT COULD BE LAUNCHERS ARE READ, because PATH is large", () => {
  // The marker inside the file is what decides. Reading every executable on PATH to find that out
  // would be a great deal of I/O for one answer, so the name cuts the population first.
  const fs = fakeFs(
    { "/opt/bin": ["ls", "node", "git", "codex-aify", "python"] },
    { "/opt/bin/codex-aify": "marker" },
  );
  aifyLauncherFilesOnPath({ env: { PATH: "/opt/bin" }, platform: "linux", ...fs });
  assert.deepEqual(fs.reads, ["/opt/bin/codex-aify"], "a file whose name cannot be a launcher was opened");
});

test("AN UNREADABLE DIRECTORY DOES NOT END THE WALK", () => {
  // A permission error on one PATH entry is ordinary. Losing every launcher after it is not, and
  // the symptom would be a host that advertises fewer runtimes than it has.
  const fs = fakeFs(
    { "/opt/bin": ["hermes-aify"] },
    { "/opt/bin/hermes-aify": "marker" },
  );
  const found = aifyLauncherFilesOnPath({ env: { PATH: "/nope:/opt/bin" }, platform: "linux", ...fs });
  assert.deepEqual(found.map((f) => f.file), ["/opt/bin/hermes-aify"]);
});

test("AN UNREADABLE FILE IS ABSENT, NEVER PRESENT WITH EMPTY TEXT", () => {
  // Fails closed. An entry with empty text would let a marker test read it as a launcher that
  // declares no runtime, which is a different and quieter wrong answer than not seeing it at all.
  const fs = fakeFs({ "/opt/bin": ["locked-aify", "ok-aify"] }, { "/opt/bin/ok-aify": "marker" });
  const found = aifyLauncherFilesOnPath({ env: { PATH: "/opt/bin" }, platform: "linux", ...fs });
  assert.deepEqual(found.map((f) => f.file), ["/opt/bin/ok-aify"]);
});

test("ONE ENTRY PER FILE, though a directory may appear on PATH twice", () => {
  // Ordinary on a shell that has been re-sourced. A duplicate would be counted twice by whatever
  // reads the markers.
  const fs = fakeFs({ "/opt/bin": ["pi-aify"] }, { "/opt/bin/pi-aify": "marker" });
  const found = aifyLauncherFilesOnPath({ env: { PATH: "/opt/bin:/opt/bin:/opt/bin" }, platform: "linux", ...fs });
  assert.equal(found.length, 1);
});

test("THE PATH SEPARATOR FOLLOWS THE PLATFORM, or every entry is one unreadable directory", () => {
  // `;` on Windows and `:` everywhere else. Split on the wrong one and a real PATH becomes a single
  // nonsense entry -- which throws in `readdir`, is caught, and reports a host with no runtimes.
  const dirs = { "C:/tools": ["claude-aify"], "C:/other": [] };
  const files = { "C:/tools/claude-aify": "marker" };
  const windows = aifyLauncherFilesOnPath({ env: { PATH: "C:/tools;C:/other" }, platform: "win32", ...fakeFs(dirs, files) });
  assert.deepEqual(windows.map((f) => f.file), ["C:/tools/claude-aify"]);
  // NEGATIVE CONTROL: the same PATH read with the posix separator finds nothing, which is what a
  // wrong separator costs and what makes the assertion above meaningful.
  const posix = aifyLauncherFilesOnPath({ env: { PATH: "C:/tools;C:/other" }, platform: "linux", ...fakeFs(dirs, files) });
  assert.deepEqual(posix, []);
});

test("AN EMPTY OR ABSENT PATH IS AN EMPTY LIST, not a throw at daemon start", () => {
  for (const env of [{}, { PATH: "" }, { PATH: "   " }, { PATH: ":::" }]) {
    assert.deepEqual(aifyLauncherFilesOnPath({ env, platform: "linux", ...fakeFs({}) }), [],
      `PATH ${JSON.stringify(env.PATH)} did not produce an empty list`);
  }
});

console.log("launcher-scan.test.js: all assertions passed");
