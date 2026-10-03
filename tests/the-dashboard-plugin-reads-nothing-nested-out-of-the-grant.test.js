// A git directory inside the grant must not lead the aify-dashboard plugin out of it through its refs or its HEAD: a
// ref or HEAD reached through a link, given a second name, or naming something that is not a ref under refs/. In every
// case here the working tree, the git directory and the shared one are all inside the grant; only something nested in
// them points out. Real git, real junctions and real hard links. What the git directory's object stores hold is in
// the-dashboard-plugin-reads-no-object-store-out-of-the-grant.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GitReader } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";
import { onlyWindows, git, slashed, layout, junction, hardLink, look } from "./_nested-grant-fixture.mjs";

test("refs/heads as a junction to another repository's refs is not read", { skip: onlyWindows }, async () => {
  // Measured on the first version of the check: the outside HEAD was reported, with none of its objects present.
  const l = layout();
  junction(join(l.dotGit, "refs", "heads"), join(l.outsideGit, "refs", "heads"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /this folder is not read: its git directory holds a link at .*folder.\.git.refs.heads;/);
});

test("refs itself as a junction is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  junction(join(l.dotGit, "refs"), join(l.outsideGit, "refs"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds a link at .*folder.\.git.refs;/);
});

test("a junction anywhere under refs, not only on the way to HEAD's ref, is not read", { skip: onlyWindows }, async () => {
  // git log reads refs/replace, so a ref HEAD does not name can still stand for something.
  const l = layout();
  git(l.outside, "tag", "v1");
  junction(join(l.dotGit, "refs", "tags"), join(l.outsideGit, "refs", "tags"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds a link at .*folder.\.git.refs.tags;/);
});

test("a ref HEAD does not name, with a second name in another repository, is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  git(l.outside, "tag", "v1");
  hardLink(join(l.dotGit, "refs", "tags", "v1"), join(l.outsideGit, "refs", "tags", "v1"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds .*refs.tags.v1, a file with a second name somewhere else/);
});

test("a HEAD naming a ref that is not under refs/ is not read", { skip: onlyWindows }, async () => {
  // The fingerprint stats the file HEAD names; a name that climbs out of refs/ would have it stat something outside.
  const l = layout();
  writeFileSync(join(l.dotGit, "HEAD"), "ref: refs/../../../outside/.git/refs/heads/main\n");
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its HEAD names "refs\/\.\.\/\.\.\/\.\.\/outside\/\.git\/refs\/heads\/main", which is not a ref name git accepts under refs\//);
});

test("a HEAD naming a ref that climbs out with backslashes is not read", { skip: onlyWindows }, async () => {
  // Measured on the second version: a check that splits on "/" passed this, and Windows read the backslashes as
  // separators, so the fingerprint statted the other repository's HEAD before anything refused.
  const l = layout();
  const climbing = "refs/heads/x\\..\\..\\..\\..\\..\\..\\outside\\.git\\HEAD";
  writeFileSync(join(l.dotGit, "HEAD"), `ref: ${climbing}\n`);
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.ok(seen.problems.includes(`its HEAD names ${JSON.stringify(climbing)}, which is not a ref name git accepts under refs/`), seen.problems);
});

test("HEAD given a second name after a folder was read is refused on the next look, quiet or not", { skip: onlyWindows }, async () => {
  // The bug: the check only after the fingerprint had read HEAD. HEAD's text stays the same, so nothing moves and the
  // next look is quiet; the fingerprint would read the other repository's HEAD on every one of them.
  const l = layout();
  const reported = [];
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(l.folder) } }] }),
      reportHead: async ({ head }) => { reported.push(head); return { ok: true, ackedHead: head, cursorRevision: 1 }; },
    },
    git: new GitReader(),
    machineId: "win32:nested-host",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [l.grant] }), "win32"), [], "win32"),
    reporter: "aify-env:win32:nested-host:r",
  });
  await watcher.tick();
  assert.equal(reported.length, 1);
  hardLink(join(l.dotGit, "HEAD"), join(l.outsideGit, "HEAD"));
  await watcher.tick();
  assert.equal(reported.length, 1);
  assert.match(watcher.state().problems.join("\n"), /its git directory holds .*folder.\.git.HEAD, a file with a second name somewhere else/);
});

/**
 * Both repositories' main ref files at one whole-second time, so swapping one for the other keeps the fingerprint
 * (size and time) as it was: copying a time through a Date loses the part of a millisecond NTFS keeps.
 */
function sameStat(l) {
  const at = new Date("2026-01-01T00:00:00Z");
  for (const ref of [join(l.dotGit, "refs", "heads", "main"), join(l.outsideGit, "refs", "heads", "main")]) utimesSync(ref, at, at);
  assert.equal(statSync(join(l.dotGit, "refs", "heads", "main")).mtimeMs, statSync(join(l.outsideGit, "refs", "heads", "main")).mtimeMs);
}

/** A watcher over the layout's folder that keeps its state across looks, and the heads it reported. */
function watching(l) {
  const reported = [];
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(l.folder) } }] }),
      reportHead: async ({ head }) => { reported.push(head); return { ok: true, ackedHead: head, cursorRevision: 1 }; },
    },
    git: new GitReader(),
    machineId: "win32:nested-host",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [l.grant] }), "win32"), [], "win32"),
    reporter: "aify-env:win32:nested-host:r",
  });
  return { watcher, reported, problems: () => watcher.state().problems.join("\n") };
}

test("refs/heads swapped for a junction on a quiet look, with the ref's size and time kept, is refused", { skip: onlyWindows }, async () => {
  // The fingerprint does not move (the same HEAD text, a ref file of the same size and time), so the look is quiet and
  // only the check made before the fingerprint reads can see that the ref is now reached through a link.
  const l = layout();
  sameStat(l);
  const w = watching(l);
  await w.watcher.tick();
  assert.equal(w.reported.length, 1);
  junction(join(l.dotGit, "refs", "heads"), join(l.outsideGit, "refs", "heads"));
  await w.watcher.tick();
  assert.equal(w.reported.length, 1);
  assert.match(w.problems(), /its git directory holds a link at .*folder.\.git.refs.heads;/);
});

test("HEAD's ref given a second name on a quiet look, with its size and time kept, is refused", { skip: onlyWindows }, async () => {
  const l = layout();
  sameStat(l);
  const w = watching(l);
  await w.watcher.tick();
  hardLink(join(l.dotGit, "refs", "heads", "main"), join(l.outsideGit, "refs", "heads", "main"));
  await w.watcher.tick();
  assert.equal(w.reported.length, 1);
  assert.match(w.problems(), /its git directory holds .*refs.heads.main, a file with a second name somewhere else/);
});

test("a loose ref with a second name in another repository is not read", { skip: onlyWindows }, async () => {
  // A hard link is no link to lstat: the file is the other repository's own, read live, and its path is inside.
  const l = layout();
  hardLink(join(l.dotGit, "refs", "heads", "main"), join(l.outsideGit, "refs", "heads", "main"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds .*refs.heads.main, a file with a second name somewhere else/);
});

test("packed-refs with a second name in another repository is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  git(l.outside, "pack-refs", "--all");
  rmSync(join(l.dotGit, "refs", "heads", "main"));
  hardLink(join(l.dotGit, "packed-refs"), join(l.outsideGit, "packed-refs"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds .*folder.\.git.packed-refs, a file with a second name somewhere else/);
});

test("HEAD with a second name in another repository is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  git(l.outside, "checkout", "-q", "--detach");
  hardLink(join(l.dotGit, "HEAD"), join(l.outsideGit, "HEAD"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds .*folder.\.git.HEAD, a file with a second name somewhere else/);
});
