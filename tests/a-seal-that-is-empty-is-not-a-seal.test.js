// An empty environment variable is not a seal. It is the default, spelled differently.
//
// MEASURED ON THE OPERATOR'S HOST, 2026-09-03, and it cost them their spawn claim twice.
// `sealedDaemonEnv` set `AIFY_SERVICE_REGISTRY` to the EMPTY STRING, with a comment stating that an
// empty path "resolves to nothing readable rather than to the operator's real one".
//
// `bin/aify-env.mjs` reads:
//
//     process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json")
//
// `""` is falsy. So the seal SELECTED the file it was written to exclude. Every test daemon read the
// operator's real registry, found the live aify-comms in it, loaded its plugin and began CLAIMING
// against production: `windows:StevenZ-L:default` changed hands, and the operator's own aify-env
// answered "not the claimer" until a reconciler released the stale claim. Nothing could take a new
// spawn in between.
//
// ADVERTISING OFF IS NOT CLAIMING OFF, which is why `AIFY_ADVERTISE=0` did not save it. The doctor
// documents that distinction in its own words -- "ADVERTISING AND CLAIMING ARE DIFFERENT
// CAPABILITIES" -- and a plugin loaded out of a registry claims whether or not it describes the
// host. Sealing the REGISTRY is what stops a test daemon finding a service to claim at all.
//
// WHY A TEST AND NOT JUST A FIX. The wrong value looked exactly like the right one: a variable was
// set, to a deliberate value, with a comment explaining the reasoning. Nothing about reading it says
// "this is the home directory". Only the `||` on the other side of the process boundary says that,
// and it is in a different repo's file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NO_REGISTRY, sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("THE REGISTRY SEAL IS A PATH, never empty", () => {
  const env = sealedDaemonEnv();
  assert.ok(env.AIFY_SERVICE_REGISTRY, "an empty seal is the operator's own registry, spelled differently");
  assert.equal(env.AIFY_SERVICE_REGISTRY, NO_REGISTRY);
});

test("the sealed path does not exist, so a daemon reading it finds no services", () => {
  // A path that resolves to a REAL file would be a different leak: a test daemon claiming against
  // whatever that file happened to describe.
  let found = true;
  try {
    readFileSync(sealedDaemonEnv().AIFY_SERVICE_REGISTRY, "utf8");
  } catch {
    found = false;
  }
  assert.equal(found, false, "the sealed registry path exists, so it names a real service list");
});

test("A TEST MAY STILL POINT SOMEWHERE DELIBERATELY", () => {
  // CONTRADICTION ARM. Without it, "always seal" would make `the-daemon-really-advertises.test.js`
  // impossible -- and a suite that cannot test advertising at all is worse than one that can, so
  // long as saying so is explicit.
  const env = sealedDaemonEnv({ AIFY_SERVICE_REGISTRY: "C:/fake/services.json" });
  assert.equal(env.AIFY_SERVICE_REGISTRY, "C:/fake/services.json");
});

test("THE DAEMON READS IT WITH `||`, which is what makes empty dangerous", () => {
  // The other side of the boundary, asserted rather than remembered. This is the line that turns an
  // empty seal into the operator's home directory, and it lives in a file no test of the helper
  // would otherwise look at. If it ever becomes `??`, empty stops being a trap and this test should
  // be the thing that says so.
  const entry = readFileSync(join(ROOT, "bin", "aify-env.mjs"), "utf8");
  const line = entry.split("\n").find((l) => l.includes("AIFY_SERVICE_REGISTRY"));
  assert.ok(line, "the daemon no longer reads AIFY_SERVICE_REGISTRY; this seal may be pointless");
  assert.match(line, /\|\|/,
    "the daemon's default changed. If it now uses ??, an empty seal is safe and this file can relax; "
    + "if it uses something else, work out what empty means before trusting the seal");
});

test("advertising off does not imply claiming off", () => {
  // The belief that made the leak survivable-looking for as long as it did. Recorded as an assertion
  // so nobody re-reasons from `AIFY_ADVERTISE=0` to "therefore it touches nothing".
  const env = sealedDaemonEnv();
  assert.equal(env.AIFY_ADVERTISE, "0");
  assert.ok(env.AIFY_SERVICE_REGISTRY,
    "claiming is not gated by AIFY_ADVERTISE, so the registry seal is what has to hold");
});
