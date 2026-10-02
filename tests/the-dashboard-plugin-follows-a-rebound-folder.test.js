// A watched folder that is re-pointed at another repository is read afresh.
//
// The watcher keeps each folder's git directories so a quiet tick costs only a stat. If the folder at that path is
// rebound (a linked worktree's `.git` file now names another git directory, a junction re-pointed, the folder
// replaced by another clone) while the OLD git directory is untouched, the old fingerprint never moves, and the
// watcher reports the old repository's HEAD for the new one forever, with no problem shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
      reportHead: async (report) => { reports.push(report.head); },
    },
    git: {
      gitDirs: async () => { calls.gitDirs += 1; return { gitDir: `C:/git/${now.bound}`, commonDir: `C:/git/${now.bound}` }; },
      head: async () => HEADS[now.bound],
    },
    machineId: "win32:h",
    watchRoots: async () => ({ roots: ["c:/w"], problems: [] }),
    reporter: "r",
    // The OLD repository's files never change: its fingerprint is constant, which is what hides the rebind.
    fingerprint: ({ gitDir }) => `HEAD=ref: refs/heads/main|of ${gitDir}`,
    binding: () => `bound to ${now.bound}`,
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
