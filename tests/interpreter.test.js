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

// ── The launcher path a POSIX shell can actually open ─────────────────────────────────
//
// MEASURED 2026-08-25 by delegating a real spawn through a real aify-env. The plan was correct --
// bash.EXE with the launcher as an argv element -- and bash reported:
//
//   /bin/bash: C:UsersAdministrator.localbinclaude-aify: No such file or directory
//
// Every separator gone, exit 127. Windows builds a command LINE out of argv, and by the time a POSIX
// shell parses it back a backslash is an escape character. What an operator sees is "the agent did not
// start", with a path in the message that looks almost right, which is the worst kind of wrong.
//
// After the fix the same spawn exits 0 and streams the launcher's own output back.

test("a Windows launcher path reaches bash with no backslashes in it", () => {
  const B = String.fromCharCode(92);
  const windowsPath = ["C:", "Users", "Administrator", ".local", "bin", "claude-aify"].join(B);
  const plan = interpreterFor("#!/usr/bin/env bash\n", windowsPath, "win32", ["--check"]);
  const launcherArg = plan.args.find((a) => a.includes("claude-aify"));
  assert.ok(launcherArg, `the launcher is not in ${JSON.stringify(plan.args)}`);
  assert.ok(!launcherArg.includes(B), `a backslash survived: ${launcherArg}`);
  assert.equal(launcherArg, "C:/Users/Administrator/.local/bin/claude-aify");
});

test("the launcher's own arguments keep their order after the path", () => {
  // `bash --managed script` is a different command from `bash script --managed`, and converting the
  // path must not disturb that.
  const B = String.fromCharCode(92);
  const plan = interpreterFor("#!/usr/bin/env bash\n", `C:${B}bin${B}x-aify`, "win32", ["--resume", "abc"]);
  assert.deepEqual(plan.args, ["C:/bin/x-aify", "--resume", "abc"]);
});

test("an argument that legitimately contains a backslash is left alone", () => {
  // Only the LAUNCHER path is converted. A caller passing a Windows path as an argument means it, and
  // the launcher -- not this function -- decides what to do with it.
  const B = String.fromCharCode(92);
  const plan = interpreterFor("#!/usr/bin/env bash\n", `C:${B}bin${B}x-aify`, "win32", [`C:${B}work`]);
  assert.equal(plan.args[1], `C:${B}work`);
});

test("a POSIX path is unchanged, because it has nothing to convert", () => {
  const plan = interpreterFor("#!/usr/bin/env bash\n", "/home/dev/.local/bin/claude-aify", "win32", []);
  assert.equal(plan.args[0], "/home/dev/.local/bin/claude-aify");
});

test("off Windows the launcher is spawned directly and is not rewritten", () => {
  // The kernel reads the shebang there; second-guessing it would break launchers that work today.
  const plan = interpreterFor("#!/usr/bin/env bash\n", "/usr/local/bin/claude-aify", "linux", ["--check"]);
  assert.equal(plan.command, "/usr/local/bin/claude-aify");
  assert.deepEqual(plan.args, ["--check"]);
});

// ── Every WSL entry point, not just the first one found ───────────────────────────────
//
// This host carries THREE bashes on PATH: Git's, System32's, and an App Execution Alias under
// AppData/Local/Microsoft/WindowsApps. The skip originally knew only System32, so a daemon whose PATH
// put WindowsApps first picked the alias and a delegated spawn died with
//
//   /bin/bash: C:/Users/Administrator/.local/bin/claude-aify: No such file or directory
//
// on a path that was correct. Measured directly: that shell answers "no" to
// `test -f C:/Users/.../claude-aify` for a file plainly there, because a WSL shell has no C: drive at
// that path. The second Windows-only defect in this one function, and the second found only by
// delegating a real spawn rather than by reading.

const WINDOWS_APPS_BASH =
  ["C:", "Users", "dev", "AppData", "Local", "Microsoft", "WindowsApps", "bash.EXE"].join(String.fromCharCode(92));
const SYSTEM32_BASH = ["C:", "Windows", "System32", "bash.EXE"].join(String.fromCharCode(92));
const GIT_BASH = ["C:", "Program Files", "Git", "usr", "bin", "bash.EXE"].join(String.fromCharCode(92));

function pathWith(...directories) {
  return {
    sep: ";",
    pathValue: directories.join(";"),
    pathExt: ["", ".EXE"],
    exists: (candidate) => [WINDOWS_APPS_BASH, SYSTEM32_BASH, GIT_BASH].includes(candidate),
  };
}

const dirOf = (full) => full.slice(0, full.lastIndexOf(String.fromCharCode(92)));

test("a WindowsApps bash is skipped in favour of a real one further down PATH", () => {
  const resolved = resolveExecutable("bash", pathWith(dirOf(WINDOWS_APPS_BASH), dirOf(GIT_BASH)));
  assert.equal(resolved, GIT_BASH, "the WSL App Execution Alias was chosen");
});

test("both WSL entry points are skipped, in either order", () => {
  for (const order of [
    [dirOf(WINDOWS_APPS_BASH), dirOf(SYSTEM32_BASH), dirOf(GIT_BASH)],
    [dirOf(SYSTEM32_BASH), dirOf(WINDOWS_APPS_BASH), dirOf(GIT_BASH)],
  ]) {
    assert.equal(resolveExecutable("bash", pathWith(...order)), GIT_BASH, order.join(" then "));
  }
});

test("with ONLY a WSL bash available it is still returned, rather than nothing", () => {
  // Skipping is a preference, not a veto. A host with no other shell should get a launch attempt and
  // a real error, not a silent refusal that looks like the launcher was never found.
  const resolved = resolveExecutable("bash", pathWith(dirOf(WINDOWS_APPS_BASH)));
  assert.equal(resolved, "bash", "an unresolvable name falls back to the bare command");
});

test("a non-shell in WindowsApps is not skipped", () => {
  // The rule is about POSIX shells that are WSL doorways, not about the directory being untrustworthy.
  const python = ["C:", "Users", "dev", "AppData", "Local", "Microsoft", "WindowsApps", "python.EXE"]
    .join(String.fromCharCode(92));
  const resolved = resolveExecutable("python", {
    sep: ";", pathValue: dirOf(python), pathExt: ["", ".EXE"],
    exists: (candidate) => candidate === python,
  });
  assert.equal(resolved, python);
});
