// A git directory inside the grant must not lead the aify-dashboard plugin out of it through its object stores: the
// objects directory or anything in it reached through a link, an object file with a second name, or a store borrowed
// through alternates that is outside the grant, holds a way out, or is reached through a link. And what agents make is
// still read. In every case here the working tree, the git directory and the shared one are all inside the grant.
// Real git, real junctions and real hard links. Refs and HEAD are in
// the-dashboard-plugin-reads-nothing-nested-out-of-the-grant.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { onlyWindows, git, slashed, repo, layout, junction, look } from "./_nested-grant-fixture.mjs";

test("objects itself as a junction is not read", { skip: onlyWindows }, async () => {
  // Caught at the top of the git directory: a walk of objects/ would read the outside store's entries, none a link.
  const l = layout();
  junction(join(l.dotGit, "objects"), join(l.outsideGit, "objects"));
  const seen = await look(l);
  assert.deepEqual(seen.reported, []);
  assert.match(seen.problems, /its git directory holds a link at .*folder.\.git.objects;/);
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
  assert.match(seen.problems, /its git directory holds .*folder.\.git.objects.*, a file of its object store that another repository shares \(a clone of a local path shares its object files on both sides, the original and the clone\); `git gc` and then `git update-server-info --force` in this folder may clear it, and the folder is judged again on its next look/);
  // 0.8.5 review, F7: re-cloning the original side could lose work that was never pushed, and a maintenance command
  // is offered as something that MAY clear it, never as a guaranteed or a safe fix.
  assert.doesNotMatch(seen.problems, /re-clone|will clear|always|safe/);
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
