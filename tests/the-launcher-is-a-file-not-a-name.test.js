// Which FILE a command name refers to on THIS machine.
//
// THE WINDOWS TRAP THIS EXISTS FOR, measured 2026-08-25. Resolving `claude-aify` the way you resolve
// an executable returns the generated `claude-aify.cmd` shim, which carries neither a shebang nor
// the wrapper marker — so a delegated spawn was refused before it started, on every Windows host,
// while the command resolved perfectly well and the file existed. The extensionless sibling beside
// it IS the launcher.
//
// ORDERING IS THE WHOLE DECISION, and it is invisible when wrong: preferring the shim makes spawning
// impossible on Windows and changes nothing on Linux, where the two are one path. That is why this
// is a pure function with its own tests rather than a loop inside the caller — and it is why the
// seam was "proven against a real environment" for weeks without anyone seeing the defect.
//
// IT JUDGES NOTHING. The allowlist is the single authority on what may execute here; a marker test
// in this module would be a copy of it that agreed until one of them was corrected.

import { test } from "node:test";
import assert from "node:assert/strict";

import { launcherCandidates, preferLauncherOverShim } from "../lib/launcher-resolve.mjs";

const WIN = {
  platform: "win32",
  env: { PATH: "C:\\bin;C:\\other", PATHEXT: ".COM;.EXE;.CMD" },
};
const NIX = { platform: "linux", env: { PATH: "/usr/bin:/usr/local/bin" } };

/** A filesystem stand-in: the set of paths that exist. */
const only = (...paths) => (path) => paths.includes(path);

test("on Windows the EXTENSIONLESS launcher is offered before the .cmd shim", () => {
  // THE DEFECT, verbatim. Both files exist; Windows would run the shim; the allowlist refuses it.
  const found = launcherCandidates("claude-aify", {
    ...WIN, exists: only("C:\\bin\\claude-aify", "C:\\bin\\claude-aify.cmd"),
  });
  assert.deepEqual(found, ["C:\\bin\\claude-aify", "C:\\bin\\claude-aify.cmd"]);
});

test("the shim is still OFFERED, not discarded", () => {
  // A host where only the shim carries the marker is a legitimate install. Refusing to look at it
  // would trade one unreachable configuration for another; the allowlist decides, not this.
  const found = launcherCandidates("claude-aify", { ...WIN, exists: only("C:\\bin\\claude-aify.cmd") });
  assert.deepEqual(found, ["C:\\bin\\claude-aify.cmd"]);
});

test("on Linux there is one path and this is inert", () => {
  // Which is exactly why the Windows defect survived a proof against a real environment.
  const found = launcherCandidates("claude-aify", { ...NIX, exists: only("/usr/bin/claude-aify") });
  assert.deepEqual(found, ["/usr/bin/claude-aify"]);
});

test("PATH is searched in ORDER, so an earlier directory wins", () => {
  const found = launcherCandidates("claude-aify", {
    ...NIX, exists: only("/usr/local/bin/claude-aify", "/usr/bin/claude-aify"),
  });
  assert.deepEqual(found, ["/usr/bin/claude-aify", "/usr/local/bin/claude-aify"],
    "PATH order decides which one a host would actually run");
});

test("a command that resolves to NOTHING returns an empty list, never a guessed path", () => {
  // Inventing a path would make the caller report "cannot read" about a file nobody installed,
  // which sends an operator looking for a permissions problem that does not exist.
  assert.deepEqual(launcherCandidates("nonesuch", { ...NIX, exists: only() }), []);
  assert.deepEqual(launcherCandidates("", NIX), []);
  assert.deepEqual(launcherCandidates(null, NIX), []);
});

test("a PATH-shaped argument is taken as given and never searched for", () => {
  // A caller that named a location meant that location. Searching PATH for something containing a
  // separator would silently run a different file with the same basename.
  const found = launcherCandidates("/opt/tools/claude-aify", {
    ...NIX, exists: only("/opt/tools/claude-aify", "/usr/bin/claude-aify"),
  });
  assert.deepEqual(found, ["/opt/tools/claude-aify"]);
});

test("a named path that does not exist yields nothing rather than itself", () => {
  assert.deepEqual(launcherCandidates("/opt/gone/claude-aify", { ...NIX, exists: only() }), []);
});

test("an empty PATH is survivable and returns nothing", () => {
  // A daemon started from a service manager can genuinely have no PATH. Throwing here would turn a
  // recoverable configuration into a dead host.
  assert.deepEqual(launcherCandidates("claude-aify", { platform: "linux", env: {}, exists: only() }), []);
});

test("preferLauncherOverShim offers the sibling only when it is really there", () => {
  assert.deepEqual(
    preferLauncherOverShim("C:\\bin\\x.cmd", { exists: only("C:\\bin\\x", "C:\\bin\\x.cmd") }),
    ["C:\\bin\\x", "C:\\bin\\x.cmd"],
  );
  assert.deepEqual(
    preferLauncherOverShim("C:\\bin\\x.cmd", { exists: only("C:\\bin\\x.cmd") }),
    ["C:\\bin\\x.cmd"],
    "a shim with no launcher beside it is a real install, not a path to invent",
  );
  assert.deepEqual(preferLauncherOverShim("/usr/bin/x", { exists: only("/usr/bin/x") }), ["/usr/bin/x"]);
  assert.deepEqual(preferLauncherOverShim(""), []);
});

test("a filesystem that THROWS is treated as absent, not as present", () => {
  // Fails closed. A path this host cannot stat is a path it cannot run, and the alternative — an
  // exception escaping a resolver — would take down the loop that starts every worker.
  const hostile = () => { throw new Error("EPERM"); };
  assert.deepEqual(launcherCandidates("claude-aify", { ...NIX, exists: hostile }), []);
});
