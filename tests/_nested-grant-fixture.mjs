// A granted folder holding one real repository to tamper with, a repository outside the grant, and one look at the
// folder by the plugin's own watcher and git reader. Shared by the two files that test what a granted git directory
// holds: the-dashboard-plugin-reads-nothing-nested-out-of-the-grant.test.js (refs and HEAD) and
// the-dashboard-plugin-reads-no-object-store-out-of-the-grant.test.js (objects and the stores they are borrowed from).
// They were one file until it neared the runner's per-file time limit under the full suite's load.

import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitReader } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

export const onlyWindows = process.platform !== "win32" && "junctions and the dashboard's Windows folders are Windows-only";
export const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
export const slashed = (path) => path.replace(/\\/g, "/");

export function repo(path, label) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "commit", "-q", "--allow-empty", "-m", label);
  return git(path, "rev-parse", "HEAD");
}

/** A granted folder holding one repository to be tampered with, and a repository outside the grant. */
export function layout() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-nested-")));
  const grant = join(scratch, "grant");
  const folder = join(grant, "folder");
  const outside = join(scratch, "outside");
  const outsideHead = repo(outside, "outside the grant");
  repo(folder, "inside the grant");
  return { scratch, grant, folder, dotGit: join(folder, ".git"), outside, outsideGit: join(outside, ".git"), outsideHead };
}

/** Replace `path` inside the folder's git directory with a junction to `target`. */
export function junction(path, target) {
  rmSync(path, { recursive: true, force: true });
  symlinkSync(target, path, "junction");
}

/** Replace `path` with a second name for the file `target`. */
export function hardLink(path, target) {
  rmSync(path, { force: true });
  linkSync(target, path);
}

/** One look at the layout's folder by a fresh watcher, granted the layout's grant. */
export async function look(l) {
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
