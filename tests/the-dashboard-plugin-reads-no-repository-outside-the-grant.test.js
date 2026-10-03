// A granted folder must not make the aify-dashboard plugin read a repository outside the grant (external review of
// 0.8.1, MEDIUM). Real git, real junctions and real .git files; the plugin's own watcher and git reader; a dashboard
// that records what it is told. Each escape is set up exactly as reproduced against 0.8.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitReader } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher, LIST_EVERY_MS } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const onlyWindows = process.platform !== "win32" && "junctions and the dashboard's Windows folders are Windows-only";
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const slashed = (path) => path.replace(/\\/g, "/");

function repo(path, label) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", label);
  return git(path, "rev-parse", "HEAD");
}

/** A scratch folder holding a granted folder and, beside it, a repository outside the grant. */
function layout() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-grant-")));
  const grant = join(scratch, "grant");
  mkdirSync(grant);
  const outside = join(scratch, "outside", "repo");
  return { scratch, grant, outside, outsideHead: repo(outside, "outside the grant") };
}

/** A real watcher over one listed folder, granted `roots`, and the heads it reports. */
function watcherOver(listed, roots) {
  const reported = [];
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(listed) } }] }),
      reportHead: async ({ head }) => { reported.push(head); return { ok: true, ackedHead: head, cursorRevision: 1 }; },
    },
    git: new GitReader(),
    machineId: "win32:grant-host",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: roots }), "win32"), [], "win32"),
    reporter: "aify-env:win32:grant-host:r",
  });
  return { watcher, reported, problems: () => watcher.state().problems.join("\n") };
}

test("a junction inside the grant that points outside it is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  symlinkSync(l.outside, join(l.grant, "junction"), "junction");
  const w = watcherOver(join(l.grant, "junction"), [l.grant]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, [], "the outside repository's HEAD was not reported");
  assert.match(w.problems(), /this folder is not read: its working tree is .*outside.repo, outside every granted root/);
});

test("a .git file naming a git directory outside the grant is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  const folder = join(l.grant, "dotgit-file");
  mkdirSync(folder);
  writeFileSync(join(folder, ".git"), `gitdir: ${slashed(join(l.outside, ".git"))}\n`);
  const w = watcherOver(folder, [l.grant]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, []);
  assert.match(w.problems(), /this folder is not read: its git directory is .*outside.repo.\.git, outside every granted root/);
});

test("a granted subfolder of a repository outside the grant is not read", { skip: onlyWindows }, async () => {
  const l = layout();
  const sub = join(l.outside, "sub");
  mkdirSync(sub);
  const w = watcherOver(sub, [sub]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, []);
  assert.match(w.problems(), /this folder is not read: its working tree is .*outside.repo, outside every granted root/);
});

test("a git directory inside the grant whose shared refs are outside it is not read", { skip: onlyWindows }, async () => {
  // The shared directory alone: the working tree and the folder's own git directory are both inside the grant, and
  // only `commondir` points out, at the repository whose branch refs and history the folder would then report.
  const l = layout();
  const linked = join(l.grant, "linked");
  git(l.outside, "worktree", "add", "-q", linked);
  const admin = join(l.grant, "linked-admin");
  cpSync(join(l.outside, ".git", "worktrees", "linked"), admin, { recursive: true });
  writeFileSync(join(admin, "commondir"), `${slashed(join(l.outside, ".git"))}\n`);
  // Removed first: git writes a worktree's .git file hidden, and Windows will not overwrite a hidden file in place.
  rmSync(join(linked, ".git"));
  writeFileSync(join(linked, ".git"), `gitdir: ${slashed(admin)}\n`);
  const w = watcherOver(linked, [l.grant]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, []);
  assert.match(w.problems(), /this folder is not read: its shared git directory is .*outside.repo.\.git, outside every granted root/);
});

test("a junction re-pointed outside after a folder was read is caught on the next look", { skip: onlyWindows }, async () => {
  // The bug: the answer kept from the first look. The .git file's text and the folder's binding stay the same; only
  // the junction its git directory is reached through moves.
  const l = layout();
  const insideHead = repo(join(l.grant, "inner"), "inside the grant");
  const hop = join(l.grant, "hop");
  symlinkSync(join(l.grant, "inner"), hop, "junction");
  const folder = join(l.grant, "folder");
  mkdirSync(folder);
  writeFileSync(join(folder, ".git"), `gitdir: ${slashed(join(hop, ".git"))}\n`);
  const w = watcherOver(folder, [l.grant]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, [insideHead], "read while the junction points inside");
  rmdirSync(hop);
  symlinkSync(l.outside, hop, "junction");
  await w.watcher.tick();
  assert.deepEqual(w.reported, [insideHead], "nothing reported once it points outside");
  assert.match(w.problems(), /this folder is not read: its git directory is .*outside.repo.\.git, outside every granted root/);
});

test("a granted root that is itself a junction still serves the folders under it", { skip: onlyWindows }, async () => {
  // The bug the check could bring: real places compared with roots as written, so a root reached through a junction
  // refuses every folder in it.
  const l = layout();
  const real = join(l.scratch, "real-root");
  const head = repo(join(real, "proj"), "under a junctioned root");
  const linkRoot = join(l.scratch, "link-root");
  symlinkSync(real, linkRoot, "junction");
  const w = watcherOver(join(linkRoot, "proj"), [linkRoot]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, [head]);
  assert.deepEqual(w.watcher.state().problems, []);
});

test("a grant narrowed under a folder already read applies from the next refresh", { skip: onlyWindows }, async () => {
  // The bug: the check made only when a folder's git directories are first resolved. Its listed path stays inside the
  // narrower grant, its binding does not move, and it goes on reporting a repository the operator no longer grants.
  const l = layout();
  const linked = join(l.grant, "linked");
  git(l.outside, "worktree", "add", "-q", linked);
  let roots = [l.grant, l.outside];
  const clock = { at: 1_000_000 };
  const reported = [];
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(linked) } }] }),
      reportHead: async ({ head }) => { reported.push(head); return { ok: true, ackedHead: head, cursorRevision: 1 }; },
    },
    git: new GitReader(),
    machineId: "win32:grant-host",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: roots }), "win32"), [], "win32"),
    reporter: "aify-env:win32:grant-host:r",
    now: () => clock.at,
  });
  await watcher.tick();
  assert.equal(reported.length, 1, "read while its main repository is granted");
  roots = [l.grant];
  clock.at += LIST_EVERY_MS;
  git(linked, "commit", "-q", "--allow-empty", "-m", "after the grant narrowed");
  await watcher.tick();
  assert.equal(reported.length, 1, "nothing reported under the narrower grant");
  assert.match(watcher.state().problems.join("\n"), /this folder is not read: its git directory is .*outside.repo.\.git.worktrees.linked, outside every granted root/);
});

test("a linked worktree is read when its main repository is granted too", { skip: onlyWindows }, async () => {
  const l = layout();
  const main = join(l.grant, "main");
  repo(main, "main");
  const linked = join(l.grant, "linked");
  git(main, "worktree", "add", "-q", linked);
  const w = watcherOver(linked, [l.grant]);
  await w.watcher.tick();
  assert.deepEqual(w.reported, [git(linked, "rev-parse", "HEAD")]);
  assert.deepEqual(w.watcher.state().problems, []);
});
