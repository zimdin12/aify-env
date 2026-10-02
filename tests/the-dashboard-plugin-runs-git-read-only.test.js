// How the aify-dashboard plugin runs git: read-only verbs, no locks, no prompts, one at a time, and
// failures an operator can act on. Half against a recording fake, half against real repositories.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitReader, READ_ONLY_VERBS } from "../lib/plugins/aify-dashboard/git-reader.mjs";

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
  const reader = new GitReader({ execFile: fake.execFile, env: { PATH: "x", GIT_OPTIONAL_LOCKS: "1" } });
  const running = reader.run("C:/somewhere", ["rev-parse", "HEAD"]);
  await new Promise((resolve) => setImmediate(resolve));
  const [call] = fake.calls;
  assert.equal(call.file, "git");
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
