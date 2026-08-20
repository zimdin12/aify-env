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

test("POSITIVE CONTROL: a REAL rendered launcher is accepted", async () => {
  // Every other case here is hand-written text. If the real marker line ever stopped matching, all of
  // them would still pass while aify-env refused every launcher on the machine.
  //
  // A RECORDED ARTIFACT rather than a live render from a sibling checkout. The first version shelled
  // out to install.sh at ~/projects/aify-wrapper, which made this suite depend on one machine's layout
  // -- and a repo whose tests only pass on the author's laptop is broken, not covered. The fixture is
  // the head of a launcher that installer really produced, rendered with generic paths so it carries
  // nothing from the machine that made it.
  //
  // THE OTHER HALF NOW EXISTS, and it had to live over there. A recording cannot notice when the thing
  // it recorded changes, so aify-wrapper asserts these same two properties on its OWN freshly rendered
  // launchers -- rendered-launchers-are-executable-by-aify-env.test.js. It can render for real because
  // it owns the installer; we cannot, without depending on one machine's layout. Between the two, a
  // template change that would make us refuse every launcher reddens where the change is made.
  const fs = await import("node:fs");
  const launcher = fs.readFileSync(new URL("./fixtures/rendered-claude-aify.head", import.meta.url), "utf8");

  const verdict = mayExecute(launcher);
  assert.equal(verdict.ok, true, `a real launcher was refused: ${verdict.reason}`);
  assert.ok(verdict.version && verdict.version.length > 0);
});

test("the launcher fixture carries nothing from the machine that rendered it", async () => {
  // It is a recorded artifact. A baked path from this laptop would be both a leak and a lie about what
  // the installer emits for anybody else.
  const fs = await import("node:fs");
  const text = fs.readFileSync(new URL("./fixtures/rendered-claude-aify.head", import.meta.url), "utf8");
  const BACKSLASH = String.fromCharCode(92);
  assert.doesNotMatch(text, new RegExp(`Administrator|Program Files|[A-Z]:${BACKSLASH}${BACKSLASH}`, "i"));
});

// ── a marker is not enough on its own ────────────────────────────────────────────
// Found by review: this module's OWN README passed. It documents the contract, so it carries the
// marker line at column zero inside a code fence — and the check could not tell that from a launcher.
//
// The consequence is not "bash would error on a .md". It is that the property claimed here — "this file
// speaks the harness contract" — was not the property being checked. aify-env executes a path a CALLER
// supplies, so any file on the host that quotes the contract (a README, a captured log, a pasted
// snippet) was enrolled by quoting it.
//
// A launcher declares its interpreter. Requiring that costs nothing real — every wrapper this project
// ships begins with a shebang, and `interpreterFor` already reads it to decide how to start one.

test("a file with the marker but NO shebang is refused", () => {
  const documentation = [
    "# Some documentation",
    "",
    "Set this in your launcher:",
    "",
    'HARNESS_WRAPPER_VERSION="0.6.0"',
    "",
  ].join(String.fromCharCode(10));
  const result = mayExecute(documentation);
  assert.equal(result.ok, false);
  assert.match(result.reason, /shebang|interpreter/i);
});

test("REGRESSION: this repo's own README is refused", async () => {
  // The exact file that exposed the gap. Named explicitly so the case cannot be lost to a rewrite of
  // the generic test above.
  const fs = await import("node:fs");
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(mayExecute(readme).ok, false, "the README is still executable by this environment");
});

test("a real launcher, which has both, is still accepted", async () => {
  // The other half. Tightening a guard until it refuses everything is not an improvement.
  const fs = await import("node:fs");
  const launcher = fs.readFileSync(new URL("./fixtures/rendered-claude-aify.head", import.meta.url), "utf8");
  assert.equal(mayExecute(launcher).ok, true);
});

test("the shebang must be the FIRST line, not merely present somewhere", () => {
  // A file that mentions #!/bin/bash in prose has not declared an interpreter, and the operating system
  // would not treat it as one either.
  const late = ["# notes", "#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
  assert.equal(mayExecute(late).ok, false);
});
