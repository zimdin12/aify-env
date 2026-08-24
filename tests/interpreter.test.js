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

import { interpreterFor, resolveExecutable } from "../lib/interpreter.mjs";

const BASH_SCRIPT = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\n';

/**
 * The interpreter is RESOLVED to a real path, because node-pty does no PATH lookup. That path is
 * machine-specific, so assert the program rather than pinning where this laptop keeps bash.
 */
const isProgram = (command, name) => {
  const base = String(command).split(/[\\/]/).pop().toLowerCase();
  assert.ok(
    base === name || base.startsWith(`${name}.`),
    `expected the ${name} interpreter, got ${command}`,
  );
};

test("on a unix host the launcher runs itself", () => {
  const plan = interpreterFor(BASH_SCRIPT, "/bin/claude-aify", "linux");
  assert.equal(plan.command, "/bin/claude-aify");
  assert.deepEqual(plan.args, []);
});

test("on WINDOWS a shebang script is run through its interpreter", () => {
  const plan = interpreterFor(BASH_SCRIPT, "C:/bin/claude-aify", "win32");
  isProgram(plan.command, "bash");
  assert.deepEqual(plan.args, ["C:/bin/claude-aify"]);
});

test("the interpreter comes from the SHEBANG, not from an extension", () => {
  // A file named .sh that says sh, and a file with no extension that says bash, must each be run the
  // way they asked. Guessing from the name is how a launcher gets run by the wrong shell.
  isProgram(interpreterFor("#!/bin/sh\n", "x.sh", "win32").command, "sh");
  isProgram(interpreterFor("#!/usr/bin/env bash\n", "x", "win32").command, "bash");
});

test("env-style shebangs resolve to the program, not to env", () => {
  const plan = interpreterFor("#!/usr/bin/env node\n", "C:/bin/thing", "win32");
  isProgram(plan.command, "node");
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
  isProgram(plan.command, "bash");
  assert.deepEqual(plan.args, ["-e", "C:/bin/x"]);
});

test("the interpreter is RESOLVED to a real path, because node-pty does no PATH lookup", () => {
  // The bug this fixes: pty.spawn("bash", ...) throws "File not found:" with nothing else in it, and
  // through the daemon that arrived as a 500 carrying no clue at all.
  const plan = interpreterFor(BASH_SCRIPT, "C:/bin/x", "win32");
  assert.notEqual(plan.command, "bash", "an unresolved name would be refused by node-pty");
  assert.ok(plan.command.includes("/") || plan.command.includes(String.fromCharCode(92)));
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

// ── resolving the executable ─────────────────────────────────────────────────────
// child_process searches PATH for you. node-pty does NOT: given "bash" it throws "File not found",
// and on the daemon that surfaced as a 500 with no clue in it. So the interpreter plan has to end in
// something the operating system can open, not something a shell would have found.

test("an absolute path is returned unchanged", () => {
  const found = resolveExecutable("/usr/bin/bash", { pathValue: "", sep: ":", pathExt: [""], exists: () => false });
  assert.equal(found, "/usr/bin/bash");
});

test("a bare name is looked up on PATH", () => {
  const found = resolveExecutable("bash", {
    pathValue: "/a:/b",
    sep: ":",
    pathExt: [""],
    exists: (candidate) => candidate === "/b/bash",
  });
  assert.equal(found, "/b/bash");
});

test("PATHEXT is tried, so bash.exe is found on Windows", () => {
  const B = String.fromCharCode(92);
  const found = resolveExecutable("bash", {
    pathValue: "C:" + B + "git" + B + "bin",
    sep: ";",
    pathExt: ["", ".EXE"],
    exists: (candidate) => candidate === "C:" + B + "git" + B + "bin" + B + "bash.EXE",
  });
  assert.equal(found, "C:" + B + "git" + B + "bin" + B + "bash.EXE");
});

test("a name that cannot be found comes back UNCHANGED, not null", () => {
  // The caller may still be using child_process, which does its own lookup. Returning null here would
  // break the path that already worked in order to fix the one that did not.
  assert.equal(
    resolveExecutable("bash", { pathValue: "/a", sep: ":", pathExt: [""], exists: () => false }),
    "bash",
  );
});

test("an exists probe that throws does not abort the search", () => {
  const found = resolveExecutable("bash", {
    pathValue: "/bad:/good",
    sep: ":",
    pathExt: [""],
    exists: (candidate) => { if (candidate.startsWith("/bad")) throw new Error("EACCES"); return true; },
  });
  assert.equal(found, "/good/bash");
});

test("POSITIVE CONTROL: bash resolves to a real absolute path on this machine", () => {
  // Every case above injects the filesystem. If the real lookup were broken, all of them would still
  // pass while every terminal-backed spawn failed with "File not found".
  const found = resolveExecutable("bash");
  assert.notEqual(found, "bash", "bash did not resolve; node-pty would refuse this");
  assert.match(found, /bash/i);
});

// WSL's bash is not a usable interpreter for a Windows-path launcher.
//
// Found on a live host, not in a fixture. `resolveExecutable("bash")` walks PATH and returns the first
// match; on a daemon whose PATH puts C:\Windows\system32 before Git's usr\bin, that is
// C:\Windows\system32\bash.EXE — WSL. It cannot open a Windows path, and bash's own quote removal eats
// the backslashes on the way, so C:\dir\probe-aify arrives as C:dirprobe-aify. Exit 127, in every path
// form: forward slashes, backslashes, short names, long names.
//
// The suite could not see it. tests that start their own daemon inherit the PATH of a Git-Bash parent,
// where Git bash comes first — the same code taking the other branch. The branch that runs on a real
// Windows host was the broken one.
//
// Skipping it and continuing the walk is the fix, not erroring: a host may legitimately have WSL bash
// AND Git bash, and the second one is the answer.
test("the System32 WSL bash is skipped when resolving a POSIX shell on Windows", () => {
  const B = String.fromCharCode(92);
  const pathValue = [`C:${B}Windows${B}system32`, `C:${B}Program Files${B}Git${B}usr${B}bin`].join(";");
  const seen = [];
  const exists = (candidate) => {
    seen.push(candidate);
    return candidate.toLowerCase().endsWith("bash.exe");
  };

  const got = resolveExecutable("bash", { pathValue, sep: ";", pathExt: ["", ".EXE"], exists });
  assert.equal(got, `C:${B}Program Files${B}Git${B}usr${B}bin${B}bash.EXE`,
    "the Git bash further down PATH is the usable one");
  assert.ok(seen.some((c) => c.toLowerCase().includes("system32")),
    "it must have LOOKED at System32 — skipping something never examined proves nothing");
});

test("a host with only the System32 bash gets the name back rather than a shell that cannot work", () => {
  const B = String.fromCharCode(92);
  const got = resolveExecutable("bash", {
    pathValue: `C:${B}Windows${B}system32`,
    sep: ";", pathExt: ["", ".EXE"],
    exists: (c) => c.toLowerCase().endsWith("bash.exe"),
  });
  // Falling back to the bare name lets the OS decide, which is what happened before any resolution
  // existed. Returning the WSL path would be actively choosing the one that cannot work.
  assert.equal(got, "bash");
});

test("System32 is only special for POSIX shells, not for every executable", () => {
  const B = String.fromCharCode(92);
  const got = resolveExecutable("where", {
    pathValue: `C:${B}Windows${B}system32`,
    sep: ";", pathExt: ["", ".EXE"],
    exists: (c) => c.toLowerCase().endsWith("where.exe"),
  });
  assert.equal(got, `C:${B}Windows${B}system32${B}where.EXE`,
    "ordinary Windows executables in System32 are exactly where they should be found");
});
