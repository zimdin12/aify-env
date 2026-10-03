// How the aify-dashboard plugin runs git: read-only verbs, no locks, no prompts, one at a time, and
// failures an operator can act on. Half against a recording fake, half against real repositories.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, linkSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitReader, READ_ONLY_VERBS, gitOnPath } from "../lib/plugins/aify-dashboard/git-reader.mjs";

/** An execFile that records each call and answers when the test says so. */
function recordingExecFile() {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const execFile = (file, args, options, callback) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ file, args, options, finish: (error, stdout = "", stderr = "") => { inFlight -= 1; callback(error, stdout, stderr); } });
  };
  return { execFile, calls, maxInFlight: () => maxInFlight };
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

function repoWithCommit() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-git-")));
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

test("git runs as a fixed argv with no shell, no optional locks and no prompt", async () => {
  // The bug: a status that takes the index lock under an agent mid-commit, or a credential prompt that
  // waits on a terminal nobody is looking at.
  const fake = recordingExecFile();
  const reader = new GitReader({ execFile: fake.execFile, env: { PATH: "x", GIT_OPTIONAL_LOCKS: "1" }, findGit: () => "C:/tools/git.exe" });
  const running = reader.run("C:/somewhere", ["rev-parse", "HEAD"]);
  await new Promise((resolve) => setImmediate(resolve));
  const [call] = fake.calls;
  assert.equal(call.file, "C:/tools/git.exe", "git by the absolute path it was found at, never a bare name");
  assert.deepEqual(call.args, ["rev-parse", "HEAD"]);
  assert.equal(call.options.cwd, "C:/somewhere");
  assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, "0", "the fixed value wins over an inherited one");
  assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(call.options.env.PATH, "x");
  assert.equal(call.options.shell, undefined);
  assert.equal(call.options.timeout, 30_000);
  call.finish(null, "abc\n");
  assert.equal(await running, "abc\n");
});

test("a verb that writes is refused before any process starts", async () => {
  const fake = recordingExecFile();
  const reader = new GitReader({ execFile: fake.execFile });
  for (const verb of ["commit", "fetch", "status", "gc"]) {
    await assert.rejects(reader.run("C:/x", [verb]), /not a read-only verb/);
  }
  assert.equal(fake.calls.length, 0);
  assert.deepEqual([...READ_ONLY_VERBS], ["rev-parse", "log", "cat-file"]);
});

test("one git process at a time, and a failed one does not stop the next", async () => {
  // The bug: two hundred folders moving at once start two hundred processes together.
  const fake = recordingExecFile();
  const reader = new GitReader({ execFile: fake.execFile });
  const runs = [1, 2, 3].map((n) => reader.run(`C:/r${n}`, ["rev-parse", "HEAD"]).then((out) => out, (error) => error));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.equal(fake.calls.length, 1, "the second waits for the first");
  fake.calls[0].finish(Object.assign(new Error("boom"), { code: 128 }), "", "fatal: not a git repository");
  await settle();
  assert.equal(fake.calls.length, 2, "the failure released the queue");
  fake.calls[1].finish(null, "two");
  await settle();
  fake.calls[2].finish(null, "three");
  const [first, second, third] = await Promise.all(runs);
  assert.match(first.message, /not a git repository/);
  assert.deepEqual([second, third], ["two", "three"]);
  assert.equal(fake.maxInFlight(), 1);
});

test("dubious ownership is named with its fix, and a timeout says it timed out", async () => {
  const fake = recordingExecFile();
  const reader = new GitReader({ execFile: fake.execFile });
  const dubious = reader.run("C:/x", ["rev-parse", "HEAD"]);
  await new Promise((resolve) => setImmediate(resolve));
  fake.calls[0].finish(Object.assign(new Error("x"), { code: 128 }), "",
    "fatal: detected dubious ownership in repository at 'C:/x'\nTo add an exception for this directory, call:");
  await assert.rejects(dubious, /dubious ownership; add it to safe\.directory/);
  const slow = reader.run("C:/x", ["rev-parse", "HEAD"]);
  await new Promise((resolve) => setImmediate(resolve));
  fake.calls[1].finish(Object.assign(new Error("x"), { killed: true, signal: "SIGTERM" }));
  await assert.rejects(slow, /took longer than 30 s/);
});

test("against a real repository: the head is the commit, and a linked worktree's refs are in the common dir", async () => {
  const dir = repoWithCommit();
  const reader = new GitReader();
  assert.equal(await reader.head(dir), git(dir, "rev-parse", "HEAD"));
  const main = await reader.gitDirs(dir);
  assert.equal(realpathSync(main.gitDir), realpathSync(join(dir, ".git")));
  assert.equal(realpathSync(main.commonDir), realpathSync(join(dir, ".git")));

  const linked = join(dir, "..", `${dir.split(/[\\/]/).pop()}-linked`);
  git(dir, "worktree", "add", "-q", "-b", "side", linked);
  const dirs = await reader.gitDirs(linked);
  assert.notEqual(realpathSync(dirs.gitDir), realpathSync(join(dir, ".git")), "a linked worktree has its own git dir");
  assert.equal(realpathSync(dirs.commonDir), realpathSync(join(dir, ".git")), "its branch refs live in the main one");
});

test("a repository with no commit yet is a failure, not a head", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-empty-")));
  git(dir, "init", "-q");
  await assert.rejects(new GitReader().head(dir), /failed|no commit/);
});

test("a git.exe planted in the watched folder is never the git that runs", { skip: process.platform !== "win32" && "Windows looks in the working directory first; elsewhere a bare name never did" }, async () => {
  // The bug (external review of 0.8.1, HIGH 3): execFile("git", { cwd }) on Windows found <folder>/git.exe before
  // PATH, so a file an agent wrote into a granted folder ran inside the daemon. The planted file is node itself:
  // run as git, it fails on "rev-parse" as a script name instead of printing the head.
  //
  // NoDefaultCurrentDirectoryInExePath turns that search off for the process that sets it, and some shells
  // do, so a test run from one passed against the defect. The daemon cannot count on it: unset here.
  const optOut = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    const dir = repoWithCommit();
    const head = git(dir, "rev-parse", "HEAD");  // read before planting: this helper runs a bare `git` too
    try { linkSync(process.execPath, join(dir, "git.exe")); } catch { copyFileSync(process.execPath, join(dir, "git.exe")); }
    assert.equal(await new GitReader().head(dir), head);
  } finally {
    if (optOut !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = optOut;
  }
});

test("git is looked up only in PATH's absolute entries, and a git found nowhere runs nothing", async () => {
  const sep = ";";
  const asked = [];
  const absolute = process.platform === "win32" ? "C:" + String.fromCharCode(92) + "tools" : "/tools";
  const found = gitOnPath({ PATH: [".", "relative", absolute].join(sep) }, {
    sep, find: (name, { pathValue }) => { asked.push(pathValue); return "git"; } });
  assert.deepEqual(asked, [absolute], "the working directory and relative entries are never searched");
  assert.equal(found, null, "a bare name back from the search is not a git to run");

  const fake = recordingExecFile();
  const reader = new GitReader({ execFile: fake.execFile, findGit: () => null });
  await assert.rejects(reader.head("C:/x"), /not on this host's PATH as an absolute path/);
  assert.equal(fake.calls.length, 0, "no process is started without an absolute git");
});
