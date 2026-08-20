// Every command this package puts on PATH is named after the package.
//
// `package.json` declared a bin called `aify-doctor`, and aify-comms already installs a DIFFERENT
// tool under exactly that name (~/.local/bin/aify-doctor, its deploy verifier). Two tiers are meant
// to sit on one host -- that is the entire point of the split -- so `npm install -g` here would have
// shadowed, or been shadowed by, a tool answering a completely different question. Whichever came
// first on PATH would win, silently, and the loser would look like it had simply changed its mind
// about what it reports.
//
// The rule is derived rather than listed: no allowlist of other projects' command names to keep
// updated, and no way for a new bin to arrive ungoverned.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** A command name this package may claim: the package name, or the package name plus a suffix. */
export function isOwnedName(packageName, binName) {
  if (binName === packageName) return true;
  return binName.startsWith(`${packageName}-`);
}

test("the rule accepts what this package owns and rejects what it does not", () => {
  assert.equal(isOwnedName("aify-env", "aify-env"), true);
  assert.equal(isOwnedName("aify-env", "aify-env-tui"), true);
  assert.equal(isOwnedName("aify-env", "aify-env-doctor"), true);
  // The name that actually collided, and its neighbours in the same family.
  assert.equal(isOwnedName("aify-env", "aify-doctor"), false);
  assert.equal(isOwnedName("aify-env", "aify-comms"), false);
  assert.equal(isOwnedName("aify-env", "doctor"), false);
  // A prefix is not a family: `aify-envelope` is somebody else's tool.
  assert.equal(isOwnedName("aify-env", "aify-envelope"), false);
});

test("every declared bin is named after this package", () => {
  const bins = Object.keys(manifest.bin ?? {});
  assert.ok(bins.length > 0, "a package with no bin would pass this vacuously");
  const foreign = bins.filter((name) => !isOwnedName(manifest.name, name));
  assert.deepEqual(foreign, [],
    `these would land on PATH under a name this package does not own: ${foreign}`);
});

test("every declared bin points at a file that exists and is executable by node", () => {
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    const full = path.join(ROOT, target);
    assert.ok(fs.existsSync(full), `${name} -> ${target} does not exist`);
    assert.ok(fs.readFileSync(full, "utf8").startsWith("#!"),
      `${name} -> ${target} has no shebang, so PATH invocation would not work`);
  }
});
