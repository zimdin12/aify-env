// A watched folder that is re-pointed at another repository is read afresh.
//
// The watcher keeps each folder's git directories so a quiet tick costs only a stat. If the folder at that path is
// rebound (a linked worktree's `.git` file now names another git directory, a junction re-pointed, the folder
// replaced by another clone) while the OLD git directory is untouched, the old fingerprint never moves, and the
// watcher reports the old repository's HEAD for the new one forever, with no problem shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindingOf } from "../lib/plugins/aify-dashboard/fingerprint.mjs";
import { HeadWatcher } from "../lib/plugins/aify-dashboard/head-watcher.mjs";

const HEADS = { A: "a".repeat(40), B: "b".repeat(40) };

test("a folder rebound to another repository is resolved again and its new head is reported", async () => {
  const now = { bound: "A" };
  const calls = { gitDirs: 0 };
  const reports = [];
  const watcher = new HeadWatcher({
    api: {
      watchList: async () => ({ hostKey: "h", projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: "C:/w/proj" } }] }),
      // Answered as the dashboard answers a folder whose commits are all covered: the head just sent is the accepted one.
      reportHead: async (report) => { reports.push(report.head); return { ackedHead: report.head, cursorRevision: reports.length }; },
    },
    git: {
      // Inside the grant, as every place git reads must be (grant-check.mjs); paths here resolve to themselves.
      gitDirs: async () => { calls.gitDirs += 1; return { toplevel: "C:/w/proj", gitDir: `C:/w/proj/.git-${now.bound}`, commonDir: `C:/w/proj/.git-${now.bound}` }; },
      head: async () => HEADS[now.bound],
    },
    machineId: "win32:h",
    watchRoots: async () => ({ roots: ["c:/w"], problems: [] }),
    reporter: "r",
    // The OLD repository's files never change: its fingerprint is constant, which is what hides the rebind.
    fingerprint: ({ gitDir }) => `HEAD=ref: refs/heads/main|of ${gitDir}`,
    binding: () => `bound to ${now.bound}`,
    realpath: (path) => path,
    // Its git directories are made up, as its fingerprint and binding are, so there is nothing on disk to look inside.
    contents: { quiet: () => "", nested: () => "" },
  });
  await watcher.tick();
  assert.deepEqual(reports, [HEADS.A]);

  now.bound = "B";
  await watcher.tick();
  assert.deepEqual(reports, [HEADS.A, HEADS.B], "the rebound folder's own head is reported");
  assert.equal(calls.gitDirs, 2, "its git directories were resolved again");

  await watcher.tick();
  assert.equal(calls.gitDirs, 2, "and a quiet tick after that resolves nothing");
  assert.deepEqual(watcher.state().problems, []);
});

test("a linked worktree whose commondir moves to other shared refs is read afresh, with its .git and HEAD unchanged", async () => {
  // The bug: the binding read the folder's `.git` file, but a linked worktree's branch refs live in the common
  // directory its git directory's `commondir` names. Re-point that, leave the old common directory untouched, and
  // the folder's own `.git`, its HEAD text and the old refs all stay the same, so nothing moved and the old
  // repository's head was reported forever. Real pointer and ref files; only git's answers are injected, and they
  // follow the same files, as git does.
  const { headFingerprint } = await import("../lib/plugins/aify-dashboard/fingerprint.mjs");
  const { grantedRoots, watchRootsFrom } = await import("../lib/watch-roots.mjs");
  const root = mkdtempSync(join(tmpdir(), "aify-dash-common-"));
  const meta = join(root, "meta");
  const worktree = join(root, "worktree");
  for (const dir of [meta, worktree, join(root, "common-one", "refs", "heads"), join(root, "common-two", "refs", "heads")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${meta}\n`);
  writeFileSync(join(meta, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(meta, "commondir"), "../common-one\n");
  writeFileSync(join(root, "common-one", "refs", "heads", "main"), `${HEADS.A}\n`);
  writeFileSync(join(root, "common-two", "refs", "heads", "main"), `${HEADS.B}\n`);

  const commonNow = () => join(meta, readFileSync(join(meta, "commondir"), "utf8").trim());
  const reports = [];
  const slashed = worktree.replace(/\\/g, "/");
  const watcher = new HeadWatcher({
    api: {
      watchList: async () => ({ hostKey: "h", projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed } }] }),
      // Answered as the dashboard answers a folder whose commits are all covered: the head just sent is the accepted one.
      reportHead: async (report) => { reports.push(report.head); return { ackedHead: report.head, cursorRevision: reports.length }; },
    },
    git: {
      gitDirs: async () => ({ toplevel: worktree, gitDir: meta, commonDir: commonNow() }),
      head: async () => readFileSync(join(commonNow(), "refs", "heads", "main"), "utf8").trim(),
    },
    machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [root] }), "win32"), [], "win32"),
    reporter: "r",
    fingerprint: headFingerprint,
  });
  await watcher.tick();
  assert.deepEqual(reports, [HEADS.A]);

  writeFileSync(join(meta, "commondir"), "../common-two\n");
  await watcher.tick();
  assert.deepEqual(reports, [HEADS.A, HEADS.B], "the head in the new common directory is reported, with the list row kept");
  assert.deepEqual(watcher.state().problems, []);
});

test("a folder's binding moves when its .git names another git directory, and holds while nothing changed", () => {
  const root = mkdtempSync(join(tmpdir(), "aify-dash-binding-"));
  const linked = join(root, "linked");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), "gitdir: C:/repos/one/.git/worktrees/linked\n");
  const first = bindingOf(linked);
  assert.equal(bindingOf(linked), first, "unchanged, it holds");
  writeFileSync(join(linked, ".git"), "gitdir: C:/repos/two/.git/worktrees/linked\n");
  assert.notEqual(bindingOf(linked), first, "re-pointed, it moves");

  const clone = join(root, "clone");
  mkdirSync(join(clone, ".git"), { recursive: true });
  assert.equal(bindingOf(clone), bindingOf(clone), "a real .git directory holds too");
  assert.notEqual(bindingOf(clone), bindingOf(join(root, "nothing-here")), "and differs from a folder with none");
});
