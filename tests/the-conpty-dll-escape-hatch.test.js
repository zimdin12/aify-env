#!/usr/bin/env node
// The switch that takes node-pty's console-list kill out of the picture, and why it is off.
//
// node-pty's ConPTY `kill()` has two implementations and only one is dangerous. The DEFAULT forks a
// helper that attaches to the console of the pty's shell pid, lists every process in that console and
// kills them all (`windowsPtyAgent.js:133-150`) -- with a dead or recycled pid that console can belong
// to another agent. The DLL branch closes the input handle and kills the pty, and never enumerates a
// console at all.
//
// OFF BY DEFAULT, DELIBERATELY. The reaper fix removes the only caller that could pass a dead pid and
// has not yet been observed in the field. Turning both on at once would confound the experiment: if
// the deaths stop, nobody would know which change did it.
//
// AND IT IS NOT A WINDOWS-ONLY SOLUTION, which is the question this file exists to answer plainly.
// `pty.spawn` builds a `UnixTerminal` on Linux and macOS and that class never reads the option, so
// setting it is inert there. The defect it guards against is Windows-only too -- `UnixTerminal.kill`
// is a plain `process.kill(pid, signal)` with no console anywhere in it.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { useConptyDll } from "../lib/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("it is OFF unless the environment asks for it", () => {
  assert.equal(useConptyDll({}), false, "an unset variable must not change how terminals are killed");
  assert.equal(useConptyDll({ AIFY_ENV_CONPTY_DLL: "" }), false);
  assert.equal(useConptyDll({ AIFY_ENV_CONPTY_DLL: "0" }), false);
  assert.equal(useConptyDll({ AIFY_ENV_CONPTY_DLL: "true" }), false,
    "only an explicit 1 flips a backend; anything else is a typo being obeyed");
});

test("an explicit 1 turns it on, whitespace and all", () => {
  assert.equal(useConptyDll({ AIFY_ENV_CONPTY_DLL: "1" }), true);
  assert.equal(useConptyDll({ AIFY_ENV_CONPTY_DLL: " 1 " }), true);
});

test("the DLL this switch selects actually ships with the package", () => {
  // Without this the flag would be a lever that silently does nothing, or worse, breaks every spawn on
  // the host it is flipped on. Checked here rather than trusted: the package could be reinstalled from
  // a build that omits it.
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("node-pty/package.json"));
  const dll = join(pkg, "build", "Release", "conpty", "conpty.dll");
  assert.ok(existsSync(dll), `node-pty ships no conpty.dll at ${dll}; the escape hatch is not usable`);
});

test("the branch it avoids is the one that kills a whole console", () => {
  // Reading the vendored source rather than describing it. If node-pty ever stops enumerating the
  // console on kill, this fix is obsolete and this test says so instead of leaving a stale comment.
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("node-pty/package.json"));
  const agent = require("node:fs").readFileSync(join(pkg, "lib", "windowsPtyAgent.js"), "utf8");
  assert.match(agent, /_getConsoleProcessList\(\)/, "node-pty no longer lists the console on kill");
  assert.match(agent, /consoleProcessList\.forEach/, "node-pty no longer kills the whole list");
  assert.match(agent, /if \(!this\._useConptyDll\)/,
    "the DLL branch that avoids the console list is gone; this switch may no longer help");
});

test("POSIX never sees the option, so this is safe to set anywhere", () => {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("node-pty/package.json"));
  const unix = require("node:fs").readFileSync(join(pkg, "lib", "unixTerminal.js"), "utf8");
  assert.doesNotMatch(unix, /useConptyDll/, "the unix terminal now reads a windows-only option");
  // And the defect itself is windows-only: a plain signal, no console anywhere.
  assert.match(unix, /UnixTerminal\.prototype\.kill/);
  assert.doesNotMatch(unix, /ConsoleProcessList/i, "the unix kill path now enumerates a console");
});
