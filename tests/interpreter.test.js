#!/usr/bin/env node
// How to actually start a launcher, which is not the same as its path.
//
// The launchers are bash scripts with a shebang. On a unix host the kernel reads that and the path is
// enough. On Windows nothing reads it: spawning `claude-aify` directly fails with EFTYPE or runs
// nothing at all, and the failure surfaces as "the agent did not start" with no reason attached.
//
// So the interpreter is DERIVED FROM THE FILE, not from an extension and not from configuration. The
// shebang is the file saying how it wants to be run, and it is already being read for the allowlist,
// so this costs nothing extra and cannot disagree with what was judged.

import assert from "node:assert/strict";
import { test } from "node:test";

import { interpreterFor } from "../lib/interpreter.mjs";

const BASH_SCRIPT = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\n';

test("on a unix host the launcher runs itself", () => {
  const plan = interpreterFor(BASH_SCRIPT, "/bin/claude-aify", "linux");
  assert.equal(plan.command, "/bin/claude-aify");
  assert.deepEqual(plan.args, []);
});

test("on WINDOWS a shebang script is run through its interpreter", () => {
  const plan = interpreterFor(BASH_SCRIPT, "C:/bin/claude-aify", "win32");
  assert.equal(plan.command, "bash");
  assert.deepEqual(plan.args, ["C:/bin/claude-aify"]);
});

test("the interpreter comes from the SHEBANG, not from an extension", () => {
  // A file named .sh that says sh, and a file with no extension that says bash, must each be run the
  // way they asked. Guessing from the name is how a launcher gets run by the wrong shell.
  assert.equal(interpreterFor("#!/bin/sh\n", "x.sh", "win32").command, "sh");
  assert.equal(interpreterFor("#!/usr/bin/env bash\n", "x", "win32").command, "bash");
});

test("env-style shebangs resolve to the program, not to env", () => {
  const plan = interpreterFor("#!/usr/bin/env node\n", "C:/bin/thing", "win32");
  assert.equal(plan.command, "node");
  assert.deepEqual(plan.args, ["C:/bin/thing"]);
});

test("a file with NO shebang is run directly, on every platform", () => {
  // A compiled binary or a .cmd has nothing to say about interpreters, and inventing one for it would
  // break the case that already worked.
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.equal(interpreterFor("MZ\u0090binary", "C:/bin/thing.exe", platform).command, "C:/bin/thing.exe");
  }
});

test("shebang arguments are preserved before the script path", () => {
  const plan = interpreterFor("#!/bin/bash -e\n", "C:/bin/x", "win32");
  assert.equal(plan.command, "bash");
  assert.deepEqual(plan.args, ["-e", "C:/bin/x"]);
});

test("extra args are appended AFTER the script, never before it", () => {
  // Order is the whole meaning here: bash --managed script is a different command from bash script
  // --managed, and one of them is not the agent anybody asked for.
  const plan = interpreterFor(BASH_SCRIPT, "C:/bin/x", "win32", ["--managed", "--aify-role", "coder"]);
  assert.deepEqual(plan.args, ["C:/bin/x", "--managed", "--aify-role", "coder"]);
});

test("a shebang line that is empty or malformed falls back to running the file directly", () => {
  for (const text of ["#!\n", "#!   \n", "#!/\n"]) {
    assert.equal(interpreterFor(text, "C:/bin/x", "win32").command, "C:/bin/x");
  }
});
