// A git directory inside the grant must not lead the aify-dashboard plugin out of it through what it holds: its refs,
// its objects, a file with a second name (a ref or an object), or an alternates file. In every case here the working tree, the git
// directory and the shared one are all inside the grant; only something nested in them points out. Real git, real
// junctions and real hard links.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitReader } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const onlyWindows = process.platform !== "win32" && "junctions and the dashboard's Windows folders are Windows-only";
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const slashed = (path) => path.replace(/\\/g, "/");

function repo(path, label) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "commit", "-q", "--allow-empty", "-m", label);
  return git(path, "rev-parse", "HEAD");
}

/** A granted folder holding one repository to be tampered with, and a repository outside the grant. */
function layout() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-nested-")));
  const grant = join(scratch, "grant");
  const folder = join(grant, "folder");
  const outside = join(scratch, "outside");
  const outsideHead = repo(outside, "outside the grant");
  repo(folder, "inside the grant");
  return { scratch, grant, folder, dotGit: join(folder, ".git"), outside, outsideGit: join(outside, ".git"), outsideHead };
}

/** Replace `path` inside the folder's git directory with a junction to `target`. */
function junction(path, target) {
  rmSync(path, { recursive: true, force: true });
  symlinkSync(target, path, "junction");
}

/** Replace `path` with a second name for the file `target`. */
function hardLink(path, target) {
  rmSync(path, { force: true });
  linkSync(target, path);
}

async function look(l) {
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
  return { reported, problems: watcher.state().problems.join("\n") };
}

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

test("objects itself as a junction is not read", { skip: onlyWindows }, async () => {
  // Caught at the top of the git directory: a walk of objects/ would read the outside store's entries, none a link.
  const l = layout();
  junction(join(l.dotGit, "objects"), join(l.outsideGit, "objects"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds a link at .*folder.\.git.objects;/);
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

test("a store borrowed from inside the grant, holding a way out, is not read", { skip: onlyWindows }, async () => {
  // Measured on the second version: the borrowed store's own path was judged and its contents were not, and git log
  // in the folder read the other repository's history through the store's pack junction.
  const l = layout();
  git(l.outside, "gc", "-q");
  const store = join(l.grant, "store", "objects");
  mkdirSync(join(store, "info"), { recursive: true });
  symlinkSync(join(l.outsideGit, "objects", "pack"), join(store, "pack"), "junction");
  writeFileSync(join(l.dotGit, "objects", "info", "alternates"), `${slashed(store)}\n`);
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its object store borrows objects from .*grant.store.objects, which holds a link at .*store.objects.pack;/);
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

test("a local clone, whose objects are second names of another repository's, is refused in one row naming the fix", { skip: onlyWindows }, async () => {
  // The bug (review of bf4ce1c, G-HARDLINK): `git clone` of a local path hard-links its objects, and git does not
  // re-hash a loose object it reads. The other repository's owner rewrote the shared file, and `git log` in the clone
  // read the new subject under the old id. The source is outside the grant here, as it was there.
  const l = layout();
  rmSync(l.folder, { recursive: true, force: true });
  git(l.grant, "clone", "-q", l.outside, l.folder);
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  // Every object of the clone has a second name; the operator is shown one row for the folder, not one per object.
  assert.equal(seen.problems.split("\n").length, 1, seen.problems);
  assert.match(seen.problems, /its git directory holds .*folder.\.git.objects.*, an object file with a second name somewhere else, as a clone of a local path makes; re-clone it with --no-hardlinks/);
});

test("a store borrowed from inside the grant, holding an object with a second name, is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  const middle = join(l.grant, "middle");
  rmSync(l.folder, { recursive: true, force: true });
  git(l.grant, "clone", "-q", l.outside, middle);
  repo(l.folder, "borrows from middle");
  writeFileSync(join(l.dotGit, "objects", "info", "alternates"), `${slashed(join(middle, ".git", "objects"))}\n`);
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its object store borrows objects from .*middle.\.git.objects, which holds .*middle.\.git.objects.*, a file with a second name somewhere else/);
});

test("what agents make is still read: a clone from a URL, a clone with --no-hardlinks, a linked worktree, a repository after gc", { skip: onlyWindows }, async () => {
  // The refusal of second-named objects must not catch the ways a repository is normally made here.
  const made = {
    "a clone from a URL": (l) => git(l.grant, "clone", "-q", `file://${slashed(l.outside)}`, l.folder),
    "a clone with --no-hardlinks": (l) => git(l.grant, "clone", "-q", "--no-hardlinks", l.outside, l.folder),
    "a linked worktree": (l) => {
      const main = join(l.grant, "main");
      repo(main, "a main checkout inside the grant");
      git(main, "worktree", "add", "-q", "-b", "side", l.folder);
    },
    "a repository after gc": (l) => {
      repo(l.folder, "to be packed");
      git(l.folder, "commit", "-q", "--allow-empty", "-m", "a second commit");
      git(l.folder, "gc", "-q");
    },
  };
  for (const [what, make] of Object.entries(made)) {
    const l = layout();
    rmSync(l.folder, { recursive: true, force: true });
    make(l);
    const seen = await look(l);
    assert.deepEqual(seen.reported, [git(l.folder, "rev-parse", "HEAD")], what);
    assert.equal(seen.problems, "", what);
  }
});

test("a junction inside objects is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  junction(join(l.dotGit, "objects", "pack"), join(l.outsideGit, "objects", "pack"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds a link at .*folder.\.git.objects.pack;/);
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

test("alternates naming an object store outside the grant are not read, whether written whole or relative", { skip: onlyWindows }, async () => {
  for (const named of [(l) => slashed(join(l.outsideGit, "objects")), () => "../../../../outside/.git/objects"]) {
    const l = layout();
    writeFileSync(join(l.dotGit, "objects", "info", "alternates"), `${named(l)}\n`);
    const seen = await look(l);
    assert.deepEqual(seen.reported, [], named(l));
    // The real path of the outside store: a relative entry read from the object store that names it, as git reads it.
    assert.match(seen.problems, /its object store borrows objects from .*outside.\.git.objects, outside every granted root/, named(l));
  }
});

test("alternates are followed through a store inside the grant to one outside it", { skip: onlyWindows }, async () => {
  const l = layout();
  const middle = join(l.grant, "middle");
  repo(middle, "a store inside");
  writeFileSync(join(middle, ".git", "objects", "info", "alternates"), `${slashed(join(l.outsideGit, "objects"))}\n`);
  writeFileSync(join(l.dotGit, "objects", "info", "alternates"), `${slashed(join(middle, ".git", "objects"))}\n`);
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its object store borrows objects from .*outside.\.git.objects, outside every granted root/);
});

test("alternates inside the grant are read as before", { skip: onlyWindows }, async () => {
  // The refusal must not reach a store that is the operator's to grant: one borrowed from inside the grant is fine.
  const l = layout();
  const middle = join(l.grant, "middle");
  repo(middle, "a store inside");
  writeFileSync(join(l.dotGit, "objects", "info", "alternates"), `${slashed(join(middle, ".git", "objects"))}\n`);
  const seen = await look(l);
  assert.deepEqual(seen.reported, [git(l.folder, "rev-parse", "HEAD")]);
  assert.equal(seen.problems, "");
});

test("a store borrowed by git clone --reference, its folder renamed in case since, is still read", { skip: onlyWindows }, async () => {
  // An alternates line must name its store as spelled, and a case-only difference is allowed: git keeps the line as
  // it wrote it at clone time (in the path's real case then, measured on git 2.54), and a folder renamed in case
  // later is the same folder on Windows, reached through no link. A rule that refused this would refuse those clones.
  const l = layout();
  const store = join(l.grant, "store");
  repo(store, "the referenced store");
  rmSync(l.folder, { recursive: true, force: true });
  git(l.grant, "clone", "-q", "--reference", store, `file://${slashed(store)}`, l.folder);
  renameSync(store, `${store}-renaming`);
  renameSync(`${store}-renaming`, join(l.grant, "Store"));
  const line = readFileSync(join(l.dotGit, "objects", "info", "alternates"), "utf8").trim();
  assert.ok(line.includes("/store/") && realpathSync.native(line).includes("\\Store\\"), `the line and the real path differ in case: ${line}`);
  const seen = await look(l);
  assert.deepEqual(seen.reported, [git(l.folder, "rev-parse", "HEAD")]);
  assert.equal(seen.problems, "");
});
