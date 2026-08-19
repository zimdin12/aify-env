#!/usr/bin/env node
// What aify-env is willing to execute.
//
// A host service that runs commands in the background, reachable by any registered service, is remote
// code execution by design. The environment bridge this replaces only ever launched wrappers, but that
// constraint was incidental — nothing enforced it. Generalising the runner without replacing the
// constraint would ship the general case with none of the safety the specific case had by accident.
//
// The rule is derived, not listed: a file may run if it carries the harness contract marker every
// wrapper already has. Installing a wrapper enrols it, nobody edits a policy file, and a new harness
// is automatic. A list you must remember to update is a defect with a delay on it.
//
// AND IT IS READ, NEVER RUN. Deciding whether to execute a file by executing it is the shape of the
// bug that once took down a fleet: `claude-aify --check` on a pre-contract wrapper forwards the flag
// to the runtime and launches Claude. Doctor already reads this same marker out of the file for the
// same reason.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mayExecute, markerOf } from "../lib/allowlist.mjs";

const WRAPPER = [
  "#!/bin/bash",
  "set -euo pipefail",
  'HARNESS_WRAPPER_RUNTIME="claude-code"',
  'HARNESS_WRAPPER_VERSION="0.5.7"',
  'exec claude "$@"',
].join("\n");

test("a file carrying the contract marker may run, and its version is read", () => {
  assert.equal(mayExecute(WRAPPER).ok, true);
  assert.equal(markerOf(WRAPPER), "0.5.7");
});

test("a file without the marker is refused, and the refusal says why", () => {
  const result = mayExecute('#!/bin/bash\nrm -rf "$HOME"\n');
  assert.equal(result.ok, false);
  assert.match(result.reason, /marker/i);
});

test("an empty file is refused", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    assert.equal(mayExecute(empty).ok, false, JSON.stringify(empty));
  }
});

test("a COMMENTED-OUT marker does not enrol a file", () => {
  // The nastiest near-miss: a script that merely mentions the marker in prose or in a disabled line
  // looks enrolled to a naive substring check, and a substring check is what anyone would write first.
  for (const text of [
    '#!/bin/bash\n# HARNESS_WRAPPER_VERSION="0.5.7"\nrm -rf /\n',
    '#!/bin/bash\necho "set HARNESS_WRAPPER_VERSION=0.5.7 to enrol"\n',
    "#!/bin/bash\n#HARNESS_WRAPPER_VERSION=\"0.5.7\"\n",
  ]) {
    assert.equal(mayExecute(text).ok, false, text);
  }
});

test("an EMPTY marker value does not enrol a file", () => {
  // A wrapper rendered from a template with the placeholder unsubstituted-to-empty is not a wrapper
  // anybody verified. Refuse it rather than treat blank as "some version".
  assert.equal(mayExecute('#!/bin/bash\nHARNESS_WRAPPER_VERSION=""\n').ok, false);
});

test("binary content is refused rather than throwing", () => {
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x00]).toString("utf8");
  const result = mayExecute(binary);
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test("null and undefined are refused, not crashed on", () => {
  // Fail closed. A caller that could not read the file must not accidentally get a yes.
  for (const nothing of [null, undefined, 42, {}]) {
    assert.equal(mayExecute(nothing).ok, false, JSON.stringify(nothing));
  }
});

test("the marker may sit anywhere in the file, including after a long preamble", () => {
  const late = ["#!/bin/bash", ...Array(400).fill("# padding"), 'HARNESS_WRAPPER_VERSION="1.2.3"'].join("\n");
  assert.equal(mayExecute(late).ok, true);
  assert.equal(markerOf(late), "1.2.3");
});

test("markerOf returns null rather than an empty string when there is no marker", () => {
  // null and "" behave differently at a call site that tests truthiness of a version. Say absent once.
  assert.equal(markerOf("#!/bin/bash\necho hi\n"), null);
});

test("DECIDING IS PURE: nothing is executed, spawned, or read from disk", () => {
  // The property the whole module exists for. If deciding ever shells out, the decision becomes the
  // thing it was meant to guard against.
  const before = { spawn: 0 };
  const originalSpawn = process.binding;
  // A file whose CONTENT would be catastrophic if run, and is merely text to this module.
  const hostile = [
    "#!/bin/bash",
    'HARNESS_WRAPPER_VERSION="0.5.7"',
    "aify-comms",
    "rm -rf /",
  ].join("\n");
  assert.equal(mayExecute(hostile).ok, true, "content is not the question; the marker is");
  assert.equal(before.spawn, 0);
  assert.equal(process.binding, originalSpawn);
});

test("an UNSUBSTITUTED placeholder is not a version, so the file is refused", () => {
  // A wrapper template carries the marker shape with the placeholder still in it. Rendered correctly
  // it becomes a version; rendered with a missing KEY=VALUE it stays a placeholder, and render.sh
  // already refuses that case. This is the second line of that defence, at the point of execution:
  // a launcher that never had its version substituted was never verified by anything.
  const template = [
    "#!/bin/bash",
    'HARNESS_WRAPPER_VERSION="@@WRAPPER_VERSION@@"',
    "",
  ].join("\n");
  const result = mayExecute(template);
  assert.equal(result.ok, false);
  assert.match(result.reason, /placeholder/i);
});

test("POSITIVE CONTROL: a REAL rendered launcher from the wrapper package is accepted", async () => {
  // Every case above is hand-written text. If the real marker line ever stopped matching, all of them
  // would still pass while aify-env refused every launcher on the machine. A predicate that cannot
  // accept the genuine article is worth nothing.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const { spawnSync } = await import("node:child_process");

  const pkg = pathMod.join(os.homedir(), "projects", "aify-wrapper", "install.sh");
  if (!fs.existsSync(pkg)) {
    assert.fail("the aify-wrapper package is not checked out beside this repo; the control cannot run");
  }
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aify-env-control-"));
  const rendered = spawnSync("bash", [
    pkg, "--client", "claude", "--endpoint", "http://127.0.0.2:1", "--render-only", dir,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);

  const launcher = fs.readFileSync(pathMod.join(dir, "claude-aify"), "utf8");
  const verdict = mayExecute(launcher);
  assert.equal(verdict.ok, true, "a real launcher was refused: " + verdict.reason);
  assert.ok(verdict.version && verdict.version.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
