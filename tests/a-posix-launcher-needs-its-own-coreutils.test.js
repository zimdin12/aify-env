// A POSIX launcher needs its own coreutils, and on Windows nothing puts them there.
//
// MEASURED 2026-09-03, on the first spawn this host ever ran end to end — and everything else
// worked. The spawn was claimed, the terminal control was claimed, the launcher was resolved past
// the `.cmd` shim the allowlist refuses, bash was found and started. Then the wrapper died four
// hundred lines in:
//
//   C:/Users/Administrator/.local/bin/claude-aify: line 498: mktemp: command not found
//   exited 127
//
// `mktemp` ships INSIDE Git for Windows, at `<Git>/usr/bin`. That directory is deliberately not on
// the system PATH — Git puts only `<Git>/cmd` there, because a second `find.exe` and `sort.exe`
// ahead of Windows' own breaks unrelated software. A Git Bash WINDOW gets them from the shell's
// startup; a `bash.exe script` spawned directly does not.
//
// WHY THE HOST OWNS THIS. aify-env chose to run the file through that interpreter, so making the
// interpreter usable is part of choosing it. The alternative is asking every wrapper to stop using
// coreutils, which is asking each of them to work around one host's packaging.
//
// WHY THE DIRECTORIES ARE DERIVED. A hardcoded list of install locations picks whichever install it
// mentions first; deriving from the interpreter the resolver ALREADY found gives the toolchain
// belonging to the bash actually being run — on a machine with two Gits, a portable one, or one in
// an unusual place.

import { test } from "node:test";
import assert from "node:assert/strict";

import { toolchainDirsFor, withToolchainOnPath } from "../lib/shell-toolchain.mjs";

const BASH = "C:" + String.fromCharCode(92) + "Program Files" + String.fromCharCode(92)
  + "Git" + String.fromCharCode(92) + "bin" + String.fromCharCode(92) + "bash.exe";
const WIN = { platform: "win32", exists: () => true };

test("the coreutils directory comes FIRST, because that is the one that was missing", () => {
  const dirs = toolchainDirsFor(BASH, WIN);
  assert.equal(dirs[0], "C:/Program Files/Git/usr/bin",
    "usr/bin holds mktemp, sed and sort — the ones a wrapper actually calls");
  assert.ok(dirs.includes("C:/Program Files/Git/bin"));
});

test("a bash living UNDER usr/bin is handled, because that layout is real too", () => {
  // Walked up from the file rather than assumed at a fixed depth. Guessing a depth would put
  // arbitrary directories on a child's PATH on any install that is shaped differently.
  const nested = "C:/msys64/usr/bin/bash.exe";
  assert.deepEqual(toolchainDirsFor(nested, WIN)[0], "C:/msys64/usr/bin");
});

test("ONLY DIRECTORIES THAT EXIST are offered", () => {
  // A PATH entry pointing nowhere is a lookup cost paid on every command a script runs, and a
  // wrapper runs a great many.
  const only = (...keep) => (dir) => keep.includes(dir);
  const dirs = toolchainDirsFor(BASH, { platform: "win32", exists: only("C:/Program Files/Git/usr/bin") });
  assert.deepEqual(dirs, ["C:/Program Files/Git/usr/bin"]);
});

test("an interpreter in no recognisable layout contributes NOTHING", () => {
  // Refusing to guess. This is not a failure: a host whose shell lives somewhere unknown gets the
  // behaviour it had before, and a wrong guess would put unrelated directories on every PATH.
  assert.deepEqual(toolchainDirsFor("C:/tools/weirdshell.exe", WIN), []);
  assert.deepEqual(toolchainDirsFor("", WIN), []);
  assert.deepEqual(toolchainDirsFor(null, WIN), []);
});

test("on Linux this is INERT", () => {
  // `/usr/bin` is already on every PATH there, and prepending to a working environment is how you
  // break launchers that work today.
  assert.deepEqual(toolchainDirsFor("/usr/bin/bash", { platform: "linux", exists: () => true }), []);
});

test("THE DIRECTORIES ARE PREPENDED, not appended", () => {
  // A launcher asking for `sort` means the POSIX `sort`, not Windows' unrelated `sort.exe`. The same
  // is true of `find`. Appending leaves a wrapper calling Windows' `find` with POSIX arguments,
  // which fails in a way that reads as a bug in the wrapper rather than in what started it.
  const env = withToolchainOnPath({ PATH: "C:/Windows/System32" }, BASH, WIN);
  const entries = env.PATH.split(";");
  assert.equal(entries[0], "C:/Program Files/Git/usr/bin");
  assert.equal(entries[entries.length - 1], "C:/Windows/System32", "the host's own PATH must survive");
});

test("a `Path` key is REPLACED by `PATH`, never left beside it", () => {
  // Windows treats environment names case-insensitively; Node does not. An env carrying both hands
  // the child whichever the spawn layer happens to pick — and the one it picked would be the copy
  // WITHOUT these directories, which is the defect surviving its own fix.
  const env = withToolchainOnPath({ Path: "C:/Windows", OTHER: "kept" }, BASH, WIN);
  assert.deepEqual(Object.keys(env).sort(), ["OTHER", "PATH"]);
  assert.match(env.PATH, /Git\/usr\/bin/);
  assert.match(env.PATH, /C:\/Windows/);
  assert.equal(env.OTHER, "kept");
});

test("directories ALREADY on PATH are not duplicated", () => {
  // An operator running aify-env from a Git Bash window already has these. A PATH that grows a copy
  // per spawn is a slow leak nobody attributes to the thing that caused it.
  const already = "C:/Program Files/Git/usr/bin;C:/Windows";
  const env = withToolchainOnPath({ PATH: already }, BASH, {
    platform: "win32", exists: (d) => d === "C:/Program Files/Git/usr/bin",
  });
  assert.equal(env.PATH, already, "an unchanged PATH must be returned unchanged");
});

test("a trailing separator does not defeat the duplicate check", () => {
  const env = withToolchainOnPath({ PATH: "C:/Program Files/Git/usr/bin/;C:/Windows" }, BASH, {
    platform: "win32", exists: (d) => d === "C:/Program Files/Git/usr/bin",
  });
  assert.equal(env.PATH.split(";").filter((e) => e.toLowerCase().includes("usr/bin")).length, 1);
});

test("an env with NO path at all still gets one", () => {
  // A daemon started by a service manager can genuinely have no PATH, and that is the case where a
  // launcher needs this most.
  const env = withToolchainOnPath({}, BASH, WIN);
  assert.equal(env.PATH, "C:/Program Files/Git/usr/bin;C:/Program Files/Git/bin;C:/Program Files/Git/usr/local/bin");
});

test("nothing to add means the env is returned UNTOUCHED", () => {
  // Identity, not a copy: a caller comparing references should see that nothing happened, and on
  // Linux nothing ever should.
  const env = { PATH: "/usr/bin" };
  assert.equal(withToolchainOnPath(env, "/usr/bin/bash", { platform: "linux" }), env);
});
