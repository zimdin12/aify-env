// A daemon started by a test must not describe this host to the machine's real service.
//
// ADVERTISING IS ON BY DEFAULT SINCE 2026-08-30, which is right for a host and wrong for a test. A
// spawned daemon inherits `~/.aify/services.json`, finds the operator's aify-comms in it, and posts
// this machine's runtimes and terminal state -- from a process that exists for two seconds and is
// then killed. Six test files were in exactly that position the moment the default flipped.
//
// THE PROJECT HAS PAID FOR THIS TWICE. A "hostile environment" suite run pointed at the operator's
// real service and registered six agents into their production registry; a test that set an ACTION
// flag rather than a config one became the environment bridge and reaped seven live gateway hosts.
// The rule those produced: a test may set a variable that says where to LOOK, never one that makes
// something HAPPEN.
//
// DERIVED, NOT LISTED. This walks the test directory rather than naming files, so a new test that
// spawns a daemon is covered the day it is written rather than the day someone remembers this one.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sealedDaemonEnv, NO_REGISTRY } from "./_sealed-daemon-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Test files that actually START the daemon, found by what they spawn rather than what they mention. */
function daemonSpawningTests() {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }))
    // A path to the binary inside a spawn/execFile argument list. A file that only names it in a
    // comment -- three do -- is not starting anything.
    .filter(({ text }) => /(spawn|spawnSync|execFile|execFileSync)\s*\([^)]*aify-env\.mjs|\[\s*DAEMON|"bin",\s*"aify-env\.mjs"/s.test(text)
      || /DAEMON\s*=.*aify-env\.mjs/.test(text));
}

test("the scan finds the files that start a daemon", () => {
  // A walk that matched nothing would pass the rule below for ever.
  const found = daemonSpawningTests().map((entry) => entry.name);
  assert.ok(found.length >= 3,
    `only ${found.length} daemon-spawning test file(s) found; the scan is not reaching them`);
});

test("every one of them seals advertising or points it somewhere fake", () => {
  const unsealed = daemonSpawningTests()
    .filter(({ text }) => !text.includes("sealedDaemonEnv")
      && !text.includes("AIFY_ADVERTISE")
      && !text.includes("AIFY_SERVICE_REGISTRY"))
    .map((entry) => entry.name);
  assert.deepEqual(unsealed, [],
    "these spawn a real daemon that would advertise this host to the machine's real aify-comms. "
    + "Use `sealedDaemonEnv()` from ./_sealed-daemon-env.mjs, or point AIFY_SERVICE_REGISTRY at a "
    + "fake service if the test is about advertising.");
});

test("the seal turns advertising OFF and names no real registry", () => {
  const sealed = sealedDaemonEnv();
  assert.equal(sealed.AIFY_ADVERTISE, "0", "the seal does not actually stop the advertiser");
  assert.equal(sealed.AIFY_NO_DASHBOARD, "1");
  // A PATH THAT DOES NOT EXIST, never "". This asserted the empty string and thereby FROZE the bug
  // it was written to prevent: `bin/aify-env.mjs` reads
  // `process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json")`, and `""` is
  // falsy -- so the seal selected the operator's own registry. Measured 2026-09-03: test daemons
  // read it, found the live aify-comms and claimed against production, and the operator's aify-env
  // spent minutes answering "not the claimer". The intent in the old comment was right; the
  // mechanism was its opposite.
  assert.ok(sealed.AIFY_SERVICE_REGISTRY, "an empty seal IS the operator's registry, spelled differently");
  assert.equal(sealed.AIFY_SERVICE_REGISTRY, process.env.AIFY_SERVICE_REGISTRY || NO_REGISTRY);
});

test("a test can still opt back in deliberately", () => {
  // The seal is a default, not a cage: the advertising tests point at a fake service and turn it on.
  const opted = sealedDaemonEnv({ AIFY_ADVERTISE: "1", AIFY_SERVICE_REGISTRY: "/tmp/fake.json" });
  assert.equal(opted.AIFY_ADVERTISE, "1");
  assert.equal(opted.AIFY_SERVICE_REGISTRY, "/tmp/fake.json");
});

test("it carries the rest of the environment through", () => {
  // Node itself needs PATH and friends; a seal that dropped them would break every spawn.
  assert.equal(sealedDaemonEnv().PATH, process.env.PATH);
});
