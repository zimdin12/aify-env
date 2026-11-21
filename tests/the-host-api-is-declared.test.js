// What this package offers a consumer, declared rather than implied.
//
// BEFORE THIS there was no `exports` map, so every file in the tree was importable from outside and
// nothing said which of them were the interface. That is not a small distinction here: the whole
// point of the separation is that aify-env is a general HOST other `aify-` services build against,
// and a package whose public surface is "whatever files happen to exist" cannot be built against --
// every internal rename is a breaking change nobody knew they made.
//
// AN `exports` MAP IS ALSO A CLOSING DOOR. Once present, anything NOT listed becomes unimportable
// from outside, so this file checks both directions: every declared entry resolves to a real module,
// and the modules a consumer actually needs are declared. A map that names a file that has moved is
// worse than no map, because it fails at the consumer rather than here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const entries = Object.entries(manifest.exports || {});
const targets = entries.flatMap(([name, spec]) => typeof spec === 'string'
  ? [{ name, target: spec }] : Object.entries(spec).map(([condition, target]) => ({ name: `${name} (${condition})`, target })));
const daemon = join(ROOT, 'bin', 'aify-env.mjs');

function assertNoDaemonExport() {
  const entryPoint = realpathSync.native(daemon);
  assert.ok(targets.every(({ target }) => typeof target === 'string'
    && realpathSync.native(join(ROOT, target)) !== entryPoint),
  'the daemon is exported as an importable module; importing it starts the environment');
}

test("every declared export resolves to a file that exists", () => {
  const missing = [];
  for (const { name, target } of targets) {
    if (typeof target !== 'string' || !existsSync(join(ROOT, target))) missing.push(`${name} -> ${target}`);
  }
  assert.deepEqual(missing, [],
    "a declared export points at a file that is not there. This fails at the CONSUMER, in another "
    + "repo, with a resolution error that names our path -- which is why it is checked here.");
});

test("every declared export actually imports", async () => {
  // Existing is not the same as loading: a module with a bad import of its own exists and throws on
  // first use. `node --check` has passed exactly that in this project's sibling.
  assertNoDaemonExport();
  for (const [name] of entries) {
    if (name.endsWith('package.json')) continue;
    const specifier = manifest.name + name.slice(1);
    await assert.doesNotReject(() => import(specifier), `${name} is declared but does not load`);
  }
});

test("the host API a service plugin is built against is declared", () => {
  // These are what the first consumer needs. If one stops being exported, the plugin contract
  // breaks in another repo rather than here.
  for (const required of ["./service-plugins", "./start-spec", "./runner"]) {
    assert.ok(manifest.exports[required], `${required} is not part of the declared host API`);
  }
});

test("the daemon entry point is NOT part of the importable surface", () => {
  // IMPORTING IT STARTS THE ENVIRONMENT, which supersedes the one already serving and reaps its
  // managed workers. That has cost this project a live fleet. It is reachable as a `bin`, which
  // runs it deliberately, and must never be reachable as an import.
  assertNoDaemonExport();
  assert.equal(manifest.bin["aify-env"], "./bin/aify-env.mjs", "it must still be runnable as a command");
});

test("package.json is exported, because tooling reads it", () => {
  // Node refuses `require('pkg/package.json')` when an exports map omits it, and that failure is
  // reported against the CONSUMER's tooling rather than against this map.
  assert.equal(manifest.exports["./package.json"], "./package.json");
});

test("the published files include everything the exports point into", () => {
  // `files` decides what a consumer actually receives. An export naming a directory that is not
  // published resolves here and fails only once installed from a registry -- the worst place to
  // find out.
  const published = new Set((manifest.files || []).map((f) => String(f).replace(/\/$/, "")));
  const unpublished = targets
    .map(({ target }) => target.replace(/^\.\//, '').split('/')[0])
    .filter((top) => top !== "package.json" && !published.has(top));
  assert.deepEqual([...new Set(unpublished)], [],
    "an export points into a directory `files` does not publish");
});
