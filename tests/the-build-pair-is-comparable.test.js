#!/usr/bin/env node
// `Equal means current. Different means restart.` -- proven, in both directions.
//
// B4 asks the daemon to answer "am I running the code on this disk" without an operator running a
// command and comparing two hashes by eye. The two numbers existed already: the banner showed what the
// running process LOADED, `aify-env --version` showed what is on DISK. Only a human could put them
// together.
//
// WHAT MAKES THE COMPARISON EXACT is that both are computed the same way, and the risk is entirely
// there: two copies of the recipe agree until somebody edits one, and then the comparison keeps
// producing a verdict that no longer means anything. So the first test here is the CONTROL -- an
// unchanged tree must report EQUAL. Without it, a `PackageBuild` that returned a fresh random value
// each call would pass every "it noticed the change" test in this file while being useless.

import assert from "node:assert/strict";
import test from "node:test";

import { DISK_BUILD_CACHE_MS, PackageBuild } from "../lib/build-identity.mjs";

/** A tree in memory: `{ "lib/a.mjs": "text" }`, walked with the same dirent contract as readdirSync. */
function fakeTree(files) {
  const tree = { ...files };
  const join = (...parts) => parts.join("/");
  const list = (dir) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Set();
    for (const path of Object.keys(tree)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const cut = rest.indexOf("/");
      names.add(cut === -1 ? rest : rest.slice(0, cut));
    }
    if (names.size === 0) throw new Error(`ENOENT: ${dir}`);
    return [...names].map((name) => ({
      name,
      isDirectory: () => !Object.hasOwn(tree, `${prefix}${name}`),
    }));
  };
  const read = (path) => {
    if (!Object.hasOwn(tree, path)) throw new Error(`ENOENT: ${path}`);
    return tree[path];
  };
  return { tree, join, list, read, root: "/pkg" };
}

/** A clock the test moves by hand, so the cache window is exercised rather than waited out. */
function fakeClock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function buildFor(files, clock = fakeClock(), cacheMs = DISK_BUILD_CACHE_MS) {
  const { root, list, read, join } = fakeTree(files);
  return new PackageBuild({ root, list, read, join, now: clock.now, cacheMs });
}

test("CONTROL: an unchanged tree reports the two identities EQUAL", () => {
  // If this ever fails, every other test in this file is passing for the wrong reason: an instrument
  // that always says "different" detects every change and is worthless.
  const clock = fakeClock();
  const build = buildFor({ "/pkg/lib/a.mjs": "one", "/pkg/bin/b.mjs": "two" }, clock);
  clock.advance(60_000);
  assert.equal(build.onDisk(), build.boot,
    "nothing on disk changed and the pair disagreed, so `different means restart` would fire forever");
});

test("an edited file moves onDisk and leaves boot alone", () => {
  const clock = fakeClock();
  const { root, tree, list, read, join } = fakeTree({
    "/pkg/lib/a.mjs": "one",
    "/pkg/bin/b.mjs": "two",
  });
  const build = new PackageBuild({ root, list, read, join, now: clock.now, cacheMs: DISK_BUILD_CACHE_MS });
  const atBoot = build.boot;

  tree["/pkg/lib/a.mjs"] = "one, fixed";
  clock.advance(60_000);

  assert.notEqual(build.onDisk(), atBoot, "the disk changed and onDisk did not move");
  assert.equal(build.boot, atBoot,
    "boot moved. It is the identity of the files this PROCESS loaded; recomputing it would report "
    + "whatever is on disk now, which is the one answer that cannot say whether to restart");
});

test("a file added under lib/plugins/ moves it, because the walk recurses", () => {
  // The regression this guards is real and cost four commits: `sourceFiles` listed `lib/*`
  // non-recursively, so the whole aify-comms plugin was outside the build id and changing it reported
  // no change. The pair inherits that walk, so it inherits the risk.
  const clock = fakeClock();
  const { root, tree, list, read, join } = fakeTree({ "/pkg/lib/a.mjs": "one", "/pkg/bin/b.mjs": "two" });
  const build = new PackageBuild({ root, list, read, join, now: clock.now, cacheMs: DISK_BUILD_CACHE_MS });

  tree["/pkg/lib/plugins/aify-comms/claim.mjs"] = "a day of work";
  clock.advance(60_000);
  assert.notEqual(build.onDisk(), build.boot, "a file one directory down was invisible to the build id");
});

test("within the cache window the tree is not re-read", () => {
  // Asked on every heartbeat and answered by hashing every source file, so the window is what keeps
  // this off the hot path. Counted rather than timed: a wall-clock assertion on this host is noise.
  const clock = fakeClock();
  const { root, tree, list, read, join } = fakeTree({ "/pkg/lib/a.mjs": "one" });
  let reads = 0;
  const counted = (path) => { reads += 1; return read(path); };
  const build = new PackageBuild({ root, list, read: counted, join, now: clock.now, cacheMs: DISK_BUILD_CACHE_MS });

  const afterBoot = reads;
  tree["/pkg/lib/a.mjs"] = "changed";
  clock.advance(DISK_BUILD_CACHE_MS - 1);
  assert.equal(build.onDisk(), build.boot, "it re-read inside the window");
  assert.equal(reads, afterBoot, "it read the tree inside the cache window");

  clock.advance(2);
  assert.notEqual(build.onDisk(), build.boot, "it did not re-read once the window passed");
  assert.ok(reads > afterBoot, "the window passed and nothing was read");
});

test("the DEFAULT window is the one the constant declares", () => {
  // Every other test here passes `cacheMs` explicitly, which leaves the default untested -- raise it
  // to an hour and an operator who pulled a fix would keep being told they are current. Constructed
  // with no window at all, so this exercises the path the daemon actually takes.
  const clock = fakeClock();
  const { root, tree, list, read, join } = fakeTree({ "/pkg/lib/a.mjs": "one" });
  const build = new PackageBuild({ root, list, read, join, now: clock.now });

  tree["/pkg/lib/a.mjs"] = "changed";
  clock.advance(DISK_BUILD_CACHE_MS - 1);
  assert.equal(build.onDisk(), build.boot, "the default window is SHORTER than the constant says");
  clock.advance(2);
  assert.notEqual(build.onDisk(), build.boot, "the default window is LONGER than the constant says");
});

test("an unreadable tree answers boot rather than throwing", () => {
  // The direction is deliberate. A tree that cannot be read reads as CURRENT, not as `restart me` --
  // an operator who acts on a spurious restart loses the agents that were running, and starting
  // aify-env supersedes the predecessor and reaps its workers.
  const clock = fakeClock();
  let broken = false;
  const { root, list, read, join } = fakeTree({ "/pkg/lib/a.mjs": "one" });
  const build = new PackageBuild({
    root,
    list: (dir) => { if (broken) throw new Error("EACCES"); return list(dir); },
    read: (path) => { if (broken) throw new Error("EIO"); return read(path); },
    join,
    now: clock.now,
    cacheMs: DISK_BUILD_CACHE_MS,
  });

  broken = true;
  clock.advance(60_000);
  assert.equal(build.onDisk(), build.boot,
    "an unreadable tree must read as current, and must never take the daemon down");
});

test("THE MECHANISM: zero files is an absence, not the empty digest", () => {
  // The test above found this and the symptom alone would not have named it. `sourceFiles` swallows
  // an unreadable directory ON PURPOSE, so a broken tree does not throw -- it yields `[]`, and
  // hashing nothing returns the sha256 of the empty string. That is a well-formed eight-character
  // build id that differs from every real one, so the daemon would advertise `restart me` on a
  // permissions blip. Restarting reaps the managed workers, so the cost of that false alarm is a
  // fleet. A try/catch could never have caught it: nothing throws.
  const EMPTY_DIGEST = "e3b0c442";
  const clock = fakeClock();
  const { root, join } = fakeTree({ "/pkg/lib/a.mjs": "one" });
  const build = new PackageBuild({
    root,
    list: () => [],                       // a walk that finds nothing, without failing
    read: () => "",
    join,
    now: clock.now,
    cacheMs: DISK_BUILD_CACHE_MS,
  });
  assert.notEqual(build.boot, EMPTY_DIGEST,
    "a walk that found no files reported the empty digest as this package's identity");
  assert.equal(build.boot, null, "an absence must stay an absence rather than becoming a value");

  // And the advertisement drops it, rather than sending an empty string that compares unequal to
  // every instance and reports every host stale.
  clock.advance(60_000);
  assert.equal(build.onDisk(), build.boot);
});

test("the advertisement CARRIES the pair, which is the half an operator never sees otherwise", async () => {
  // Both ends of a new field, because a field nothing carries changes nothing. The reader is
  // aify-comms' `bridge-current`, which judges these two against each other; this end proves the
  // values reach it.
  const { environmentAdvertisement } = await import("../lib/advertise.mjs");
  const sent = environmentAdvertisement({
    hostname: "host", kind: "windows", os: "windows", machineId: "m",
    runtimes: [], terminal: true, version: "0.6.2",
    instance: "aaaa1111", codeOnDisk: "bbbb2222",
  });
  assert.equal(sent.metadata.instance, "aaaa1111");
  assert.equal(sent.metadata.codeOnDisk, "bbbb2222");

  // OMITTED, not empty, when a caller cannot compute it: an absent field reads as "cannot tell",
  // where an empty string would compare unequal to every instance and report every host stale.
  const older = environmentAdvertisement({
    hostname: "host", kind: "windows", os: "windows", machineId: "m",
    runtimes: [], terminal: true, version: "0.6.2", instance: "aaaa1111",
  });
  assert.ok(!("codeOnDisk" in older.metadata),
    "an advertiser that cannot compute the disk build must omit the field, not send an empty one");
});
