// What git reads in one look is what that look judged, not whatever the listed path leads to a moment later.
//
// The bug (review of bf4ce1c, G-RACE): the checks judged the real places git resolved, and then `git rev-parse HEAD`
// ran in the LISTED folder. A junction on the listed path re-pointed outside between the two, and the outside HEAD was
// reported on that same look; the next look refused the folder, after the report had gone. Each case here makes its
// change at the same moment the reviewer did: after the real fingerprint has read, before git runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { headFingerprint } from "../lib/plugins/aify-dashboard/fingerprint.mjs";
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

function layout() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-judged-")));
  const grant = join(scratch, "grant");
  const inside = join(grant, "inside");
  const outside = join(scratch, "outside");
  return { grant, inside, outside, insideHead: repo(inside, "inside the grant"), outsideHead: repo(outside, "outside the grant") };
}

/** A real watcher over `listed` whose real fingerprint is followed, on its first look only, by `change`. */
function watcherOver(listed, grant, change) {
  const reported = [];
  let looks = 0;
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(listed) } }] }),
      reportHead: async ({ head }) => { reported.push(head); return { ok: true, ackedHead: head, cursorRevision: 1 }; },
    },
    git: new GitReader(),
    machineId: "win32:judged-host",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [grant] }), "win32"), [], "win32"),
    reporter: "aify-env:win32:judged-host:r",
    fingerprint: (dirs) => {
      const print = headFingerprint(dirs);
      if (looks++ === 0) change();
      return print;
    },
  });
  return { watcher, reported, problems: () => watcher.state().problems.join("\n") };
}

test("a junction on the listed path re-pointed outside after the checks is not followed on that look", { skip: onlyWindows }, async () => {
  // The reviewer's schedule, replayed.
  const l = layout();
  const hop = join(l.grant, "hop");
  symlinkSync(l.inside, hop, "junction");
  const w = watcherOver(hop, l.grant, () => { rmdirSync(hop); symlinkSync(l.outside, hop, "junction"); });
  await w.watcher.tick();
  // The head of what was judged, so the case cannot pass by reporting nothing.
  assert.deepEqual(w.reported, [l.insideHead], "the look reports the repository it judged");
  await w.watcher.tick();
  assert.deepEqual(w.reported, [l.insideHead], "and never the one the junction leads to now");
  assert.match(w.problems(), /this folder is not read: its working tree is .*outside, outside every granted root/);
});

test("a worktree's .git file re-pointed outside after the checks is not followed on that look", { skip: onlyWindows }, async () => {
  // Running git in the judged working tree is not enough on its own: git would read the .git file there again. The
  // judged git directory is handed to git, so the file is not consulted.
  const l = layout();
  const worktree = join(l.grant, "worktree");
  git(l.inside, "worktree", "add", "-q", "-b", "side", worktree);
  const dotGit = join(worktree, ".git");
  const w = watcherOver(worktree, l.grant, () => {
    // git makes this file hidden, and Windows refuses to overwrite a hidden file.
    rmSync(dotGit, { force: true });
    writeFileSync(dotGit, `gitdir: ${slashed(join(l.outside, ".git"))}\n`);
  });
  await w.watcher.tick();
  assert.deepEqual(w.reported, [l.insideHead], "the look reports the worktree it judged");
  await w.watcher.tick();
  assert.deepEqual(w.reported, [l.insideHead]);
  assert.match(w.problems(), /this folder is not read: its git directory is .*outside.\.git, outside every granted root/);
});

test("a range read after a junction on the listed path is re-pointed is the judged repository's history", { skip: onlyWindows }, async () => {
  // The same schedule for the commits behind the head: hasCommit, contains and the log of the range must read what
  // was judged too. The outside repository holds the base and not the inside head, so a range read through the
  // listed path cannot read the same history by coincidence.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-judged-range-")));
  const grant = join(scratch, "grant");
  const inside = join(grant, "inside");
  const outside = join(scratch, "outside");
  const base = repo(inside, "the base, in both");
  git(scratch, "clone", "-q", "--no-hardlinks", inside, outside);
  git(outside, "commit", "-q", "--allow-empty", "-m", "outside only");
  git(inside, "commit", "-q", "--allow-empty", "-m", "the inside head");
  const insideHead = git(inside, "rev-parse", "HEAD");
  const hop = join(grant, "hop");
  symlinkSync(inside, hop, "junction");

  // A dashboard that has accepted the base, so the first look reports the range from it to the head.
  const coverage = { acked: base, sent: [] };
  let looks = 0;
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(hop) } }] }),
      reportHead: async () => ({ ok: true, ackedHead: coverage.acked, cursorRevision: 1 }),
      openRange: async ({ targetHead }) => ({ rangeId: "r1", targetHead }),
      sendBatch: async (rangeId, batch) => {
        coverage.sent.push(...batch.commits.map((commit) => commit.subject));
        if (!batch.hasMore) coverage.acked = insideHead;
        return { state: batch.hasMore ? "open" : "complete" };
      },
      resync: async () => { throw new Error("no resync is expected"); },
    },
    git: new GitReader(),
    machineId: "win32:judged-host",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [grant] }), "win32"), [], "win32"),
    reporter: "aify-env:win32:judged-host:r",
    fingerprint: (dirs) => {
      const print = headFingerprint(dirs);
      if (looks++ === 0) { rmdirSync(hop); symlinkSync(outside, hop, "junction"); }
      return print;
    },
  });
  await watcher.tick();
  assert.deepEqual(watcher.state().problems, []);
  assert.deepEqual(coverage.sent, ["the inside head"], "the range of the repository that was judged");
});

test("a head asked for by a folder's path, not its judged places, runs no git", async () => {
  // The way back to the bug is one call that passes the listed path again. It is refused, not quietly run there.
  let started = 0;
  const reader = new GitReader({ execFile: () => { started += 1; }, findGit: () => "C:/git/git.exe" });
  await assert.rejects(reader.head("C:/w/proj"), /needs the folder's judged working tree and git directory/);
  await assert.rejects(reader.head({ toplevel: "C:/w/proj" }), /needs the folder's judged working tree and git directory/);
  // And every read of the history behind a head.
  const id = "a".repeat(40);
  await assert.rejects(reader.hasCommit("C:/w/proj", id), /needs the folder's judged working tree and git directory/);
  await assert.rejects(reader.contains("C:/w/proj", id, id), /needs the folder's judged working tree and git directory/);
  await assert.rejects(reader.commitsBetween("C:/w/proj", id, id), /needs the folder's judged working tree and git directory/);
  assert.equal(started, 0);
});
