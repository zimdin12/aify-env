// `aify-env credential set` stored nothing, printed nothing, and exited 0.
//
// THE SHAPE. `bin/aify-env-credential.mjs` runs its `main()` only when `process.argv[1]` ends with
// its own filename -- a guard that exists so tests can import its parsing helpers without the command
// executing against the operator's real home directory. The dispatcher in `bin/aify-env.mjs` rewrote
// argv but kept ITS OWN path in slot 1, so through `aify-env credential ...` that guard was false and
// the module loaded without doing anything. Exit status 0. No file written. No output.
//
// WHAT IT COST, measured 2026-09-02. aify-comms' installer runs `aify-env credential set` and reads
// the credential REFERENCE off stdout. It got an empty string, published no `credentialRef` to
// `~/.aify/services.json`, and aify-env then had no way to find a key it had never stored. Every
// advertisement to the service 401'd, no environment came online, and spawns refused -- with both
// daemons reporting healthy and nothing anywhere naming a credential.
//
// A COMMAND THAT SILENTLY DOES NOTHING AND REPORTS SUCCESS is the worst outcome available, and it is
// invisible to every check that reads an exit status. So this test asserts the EFFECT -- a file on
// disk and a reference on stdout -- rather than the status.
//
// PIPED ON PURPOSE. `process.exit()` discards buffered stdout when stdout is a pipe and flushes
// synchronously when it is a TTY, so an interactive check would pass over a second, independent
// defect on the same line. Capturing stdout is what the installer does and is the case that must work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(fileURLToPath(new URL("../bin/", import.meta.url)));
const DISPATCHER = join(BIN, "aify-env.mjs");
const DIRECT = join(BIN, "aify-env-credential.mjs");

/** Run a credential set with the store redirected, and return what the command printed. */
function setCredential(script, root) {
  return execFileSync(
    process.execPath,
    [script, ...(script === DISPATCHER ? ["credential"] : []), "set", "--service", "aify-comms", "--stdin"],
    // HOME *and* USERPROFILE: `credentialRoot()` defaults to `os.homedir()`, which reads USERPROFILE
    // on Windows and HOME elsewhere. Redirecting one leaves the other pointing at the operator's real
    // store, and the test would then write there while asserting against an empty temp directory.
    {
      input: "a-test-key",
      encoding: "utf8",
      env: { ...process.env, HOME: root, USERPROFILE: root },
      timeout: 60000,
    },
  ).trim();
}

function storedFiles(root) {
  try {
    return readdirSync(join(root, ".aify", "credentials"));
  } catch {
    return [];
  }
}

/** One set through `script` into a home of its own: the reference printed, and the files the store then held. */
function setOnce(script) {
  const root = mkdtempSync(join(tmpdir(), "aify-env-dispatch-"));
  try {
    const ref = setCredential(script, root);
    return { ref, stored: storedFiles(root) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
// ONE SET PER PATH. The agreement test ran both paths a second time just to compare what the first two tests had
// already seen; all three read these two runs now.
const runs = new Map();
const through = (script) => {
  if (!runs.has(script)) runs.set(script, setOnce(script));
  return runs.get(script);
};

test("through the DISPATCHER it stores the key and prints the reference", () => {
  const { ref, stored } = through(DISPATCHER);
  assert.match(ref, /^aify-comms-[0-9a-f]+\.key$/,
    `the dispatcher printed ${JSON.stringify(ref)} instead of a credential reference; the installer `
    + "records this in its registry, and an empty one leaves aify-env unable to find its own key");
  assert.deepEqual(stored, [ref], "the command reported success and wrote no credential file");
});

test("CONTROL: the direct entry point behaves identically", () => {
  // Without this the test above could pass on a build where BOTH paths are broken in the same way,
  // and it is the direct path that was working while the dispatcher was not -- the difference is the
  // whole finding.
  const { ref, stored } = through(DIRECT);
  assert.match(ref, /^aify-comms-[0-9a-f]+\.key$/);
  assert.deepEqual(stored, [ref]);
});

test("the two paths agree on the reference they produce", () => {
  // One key, one name. If they diverged, an installer that used one and a daemon that resolved the
  // other would both be correct and still never meet.
  assert.equal(through(DISPATCHER).ref, through(DIRECT).ref);
});
