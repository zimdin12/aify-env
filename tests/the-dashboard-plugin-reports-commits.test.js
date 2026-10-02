// The aify-dashboard plugin reporting the commits between the accepted head and the new one, against real
// repositories and a dashboard that keeps coverage by the dashboard's own rules (aify-dashboard
// server/src/commits/range.ts, read 2026-10-03):
// - a first head report sets the accepted head; a moved head bumps the cursor and leaves it;
// - a range opens only from the accepted head, at the current cursor, and not from a head to itself;
// - batches arrive in index order, each after the last one's final commit, only from the range's opener;
// - the closing batch moves the accepted head to the range's target, unless the cursor moved meanwhile;
// - a resync must name the accepted head and the current cursor, and moves the accepted head to the new one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DashboardApi } from "../lib/plugins/aify-dashboard/dashboard-api.mjs";
import { GitReader, parseLog } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher, TICK_MS } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { batchesOf, BATCH_SIZE } from "../lib/plugins/aify-dashboard/range-reporter.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const onlyWindows = process.platform !== "win32" && "the dashboard resolves Windows folders only, so this slice watches only them";
const MACHINE = "win32:test-host";
const REPORTER = "aify-env:win32:test-host:one";
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const slashed = (path) => path.replace(/\\/g, "/");

/** A dashboard that keeps one folder's coverage by the rules above, and records everything it was sent. */
async function coverageDashboard(listedPath) {
  const sent = [];
  const fail = [];
  const state = { head: "", ackedHead: "", cursor: 0, ranges: new Map(), stored: [], gaps: [] };
  const handle = (method, url, body) => {
    const failing = fail.findIndex((rule) => url.includes(rule.when));
    // A rule answers in place of the dashboard, or changes its state and returns nothing to let it answer as usual.
    const forced = failing === -1 ? undefined : fail.splice(failing, 1)[0].answer(state);
    if (forced) return forced;
    if (method === "GET" && url === "/api/v1/host/test-host/watch-list") {
      return [200, { hostKey: "test-host", projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: slashed(listedPath) } }] }];
    }
    if (method === "POST" && url === "/reports/head") {
      if (state.ackedHead === "") Object.assign(state, { head: body.head, ackedHead: body.head, cursor: 1 });
      else if (body.head !== state.head) Object.assign(state, { head: body.head, cursor: state.cursor + 1 });
      return [200, { ok: true, ackedHead: state.ackedHead, cursorRevision: state.cursor }];
    }
    const current = { ackedHead: state.ackedHead, cursorRevision: state.cursor };
    if (method === "POST" && url === `/instances/${encodeURIComponent(REPORTER)}/commit-ranges`) {
      if (body.baseHead !== state.ackedHead) return [409, { error: "stale", code: "stale_base", current }];
      if (body.cursorRevision !== state.cursor) return [409, { error: "stale", code: "stale_cursor", current }];
      if (body.targetHead === body.baseHead) return [409, { error: "same", code: "not_a_move", current }];
      const rangeId = `r${state.ranges.size + 1}`;
      state.ranges.set(rangeId, { ...body, opener: REPORTER, next: 0, continuation: null, state: "open" });
      return [201, { rangeId, baseHead: body.baseHead, targetHead: body.targetHead, cursorRevision: body.cursorRevision }];
    }
    const batch = url.match(/^\/commit-ranges\/([^/]+)\/batches$/);
    if (method === "POST" && batch) {
      const range = state.ranges.get(decodeURIComponent(batch[1]));
      if (!range || body.bridgeInstanceId !== range.opener) return [403, { error: "not the opener", code: "not_the_opener" }];
      if (range.state !== "open" || body.batchIndex !== range.next || body.afterSha !== range.continuation || body.commits.length === 0) {
        return [409, { error: "out of order", code: "out_of_order", current: { state: range.state, continuationSha: range.continuation, nextBatchIndex: range.next } }];
      }
      for (const commit of body.commits) if (!state.stored.some((kept) => kept.sha === commit.sha)) state.stored.push(commit);
      range.next += 1;
      range.continuation = body.commits.at(-1).sha;
      if (body.hasMore === false) {
        if (range.cursorRevision === state.cursor) Object.assign(state, { ackedHead: range.targetHead, cursor: state.cursor + 1 }), (range.state = "complete");
        else range.state = "superseded";
      }
      return [200, { rangeId: batch[1], batchIndex: body.batchIndex, acceptedShas: body.commits.map((c) => c.sha), continuationSha: range.continuation, state: range.state, replayed: false }];
    }
    if (method === "POST" && url === `/instances/${encodeURIComponent(REPORTER)}/resync`) {
      if (body.oldHead !== state.ackedHead || body.cursorRevision !== state.cursor) return [409, { error: "stale", code: "stale_resync", current }];
      state.gaps.push({ from: body.oldHead, to: body.newHead, reason: body.reason });
      Object.assign(state, { ackedHead: body.newHead, cursor: state.cursor + 1 });
      return [200, { ok: true, ackedHead: state.ackedHead, cursorRevision: state.cursor }];
    }
    return [404, { error: "no such route", code: "no_route" }];
  };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = text ? JSON.parse(text) : null;
      sent.push({ method: request.method, url: request.url, body });
      const [status, answer] = handle(request.method, request.url, body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, sent, fail, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function setUp(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-commits-")));
  const repo = join(root, "proj");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  const dashboard = await coverageDashboard(repo);
  t.after(() => dashboard.close());
  const spawns = [];
  const clock = { at: 1_000_000 };
  const watcher = new HeadWatcher({
    api: new DashboardApi({ endpoint: dashboard.endpoint, credential: async () => "k" }),
    git: new GitReader({ execFile: (file, args, options, callback) => { spawns.push(args); return nodeExecFile(file, args, options, callback); } }),
    machineId: MACHINE,
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [root] }), "win32"), [], "win32"),
    reporter: REPORTER,
    now: () => clock.at,
  });
  const tick = async () => { clock.at += TICK_MS; await watcher.tick(); };
  return { repo, dashboard, spawns, watcher, tick };
}

const logRuns = (spawns) => spawns.filter((args) => args[0] === "log" && args.includes("--reverse")).length;

test("batches are cut at fifty, each after the last one's final commit, the last one closing the range", () => {
  const commits = Array.from({ length: 2 * BATCH_SIZE + 3 }, (_, i) => ({ sha: `${i}`.padStart(40, "0") }));
  const batches = batchesOf(commits);
  assert.deepEqual(batches.map((b) => b.commits.length), [50, 50, 3]);
  assert.deepEqual(batches.map((b) => b.batchIndex), [0, 1, 2]);
  assert.deepEqual(batches.map((b) => b.afterSha), [null, commits[49].sha, commits[99].sha]);
  assert.deepEqual(batches.map((b) => b.hasMore), [true, true, false]);
  assert.deepEqual(batchesOf([]), []);
});

test("the commits since the accepted head are reported oldest first, with their files, and coverage reaches the head", { skip: onlyWindows }, async (t) => {
  // The bug this catches: a head that moved is reported, and the commits that moved it are not, so the
  // dashboard knows where a folder is and nothing of how it got there.
  const s = await setUp(t);
  await s.watcher.tick();
  for (let i = 1; i <= 55; i += 1) {
    if (i % 11 === 0) writeFileSync(join(s.repo, `file-${i}.txt`), `${i}\n`), git(s.repo, "add", `file-${i}.txt`);
    git(s.repo, "commit", "-q", "--allow-empty", "-m", `change ${i}`);
  }
  await s.tick();

  const expected = git(s.repo, "log", "--reverse", "--format=%H", "HEAD~55..HEAD").split("\n");
  assert.deepEqual(s.dashboard.state.stored.map((c) => c.sha), expected, "every commit, oldest first");
  const withFile = s.dashboard.state.stored.find((c) => c.subject === "change 11");
  assert.deepEqual(withFile.files, ["file-11.txt"]);
  assert.ok(Number.isSafeInteger(withFile.committedAt) && withFile.committedAt > 1_600_000_000_000, "milliseconds, as the dashboard stores them");
  const batches = s.dashboard.sent.filter((r) => r.url.endsWith("/batches")).map((r) => r.body.commits.length);
  assert.deepEqual(batches, [50, 5]);
  assert.equal(s.dashboard.state.ackedHead, git(s.repo, "rev-parse", "HEAD"), "coverage reached the head");
  assert.deepEqual(s.watcher.state().problems, []);
  assert.equal(s.watcher.state().commitsSent, 55);

  // And then nothing: a covered folder costs no git and no request on a quiet tick.
  const spawnsBefore = s.spawns.length;
  const sentBefore = s.dashboard.sent.length;
  await s.tick();
  assert.equal(s.spawns.length, spawnsBefore);
  assert.equal(s.dashboard.sent.length, sentBefore);
});

test("a refused range is retried from the cursor the dashboard gave, without reading the history again", { skip: onlyWindows }, async (t) => {
  // The bug: git log on every retry (comms-tech-lead's condition: once per head move), or a retry from the
  // stale cursor, which the dashboard refuses for ever.
  const s = await setUp(t);
  await s.watcher.tick();
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second");
  // The cursor really moves before the refusal, as it does when something else reported meanwhile: a retry from the
  // old cursor is then refused for ever, and only the cursor the refusal carries opens the range.
  s.dashboard.fail.push({ when: "/commit-ranges", answer: (state) => {
    state.cursor += 1;
    return [409, { error: "the cursor has moved", code: "stale_cursor", current: { ackedHead: state.ackedHead, cursorRevision: state.cursor } }];
  } });
  await s.tick();
  assert.match(s.watcher.state().problems.join("\n"), /409/);
  await s.tick();
  assert.deepEqual(s.watcher.state().problems, []);
  assert.equal(s.dashboard.state.ackedHead, git(s.repo, "rev-parse", "HEAD"));
  assert.equal(logRuns(s.spawns), 1, "the range's history was read once");
});

test("a range the dashboard superseded leaves coverage short, which is shown and tried again from the commits already read", { skip: onlyWindows }, async (t) => {
  // The bugs: the range completes as superseded (the cursor moved while it was sent), coverage stays behind the
  // head, and the folder reads as fine, so nothing is tried again until the head next moves. Or it is tried again,
  // and the same history between the same two ids is looked up and read a second time.
  const s = await setUp(t);
  await s.watcher.tick();
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second");
  s.dashboard.fail.push({ when: "/batches", answer: (state) => { state.cursor += 1; } });
  await s.tick();
  assert.equal(s.dashboard.state.ranges.get("r1").state, "superseded");
  assert.match(s.watcher.state().problems.join("\n"), /short of/);
  await s.tick();
  assert.equal(s.dashboard.state.ackedHead, git(s.repo, "rev-parse", "HEAD"), "the next tick covered it");
  assert.deepEqual(s.watcher.state().problems, []);
  assert.equal(logRuns(s.spawns), 1, "the range's history was read once");
  assert.equal(s.spawns.filter((args) => args.some((arg) => arg.endsWith("^{commit}"))).length, 1, "the accepted head was looked up once");
  assert.equal(s.spawns.filter((args) => args[0] === "log" && args[1] === "-1").length, 1, "its place in the history was decided once");
});

test("file names and subjects arrive exactly as git holds them", { skip: onlyWindows }, async (t) => {
  // The bugs: git quotes a name outside ASCII ("na\303\257ve.txt") unless told not to, a trimmed line loses a
  // name's leading space, and a subject holding the character the fields were split on is cut there.
  const s = await setUp(t);
  await s.watcher.tick();
  const names = ["na\u00efve.txt", " leading space.txt", "with space.txt"];
  for (const name of names) writeFileSync(join(s.repo, name), `${name}\n`);
  git(s.repo, "add", "-A");
  const subject = "split \x1f here, \x1e there, \"quoted\" and caf\u00e9";
  git(s.repo, "commit", "-q", "-m", subject);
  await s.tick();
  assert.deepEqual(s.watcher.state().problems, []);
  assert.equal(s.dashboard.state.stored.length, 1);
  assert.deepEqual([...s.dashboard.state.stored[0].files].sort(), [...names].sort());
  assert.equal(s.dashboard.state.stored[0].subject, subject);
});

test("a log that does not parse is refused whole, never read as shorter subjects or extra files", () => {
  // The bug: a record that does not fit the framing is read anyway, and the dashboard stores a subject cut short, or
  // the next commit's id as a file name. Each row breaks one thing the parser checks.
  const sha = "a".repeat(40);
  const good = `\0${sha}\x001790000000\0subject\0\nfile.txt\0`;
  assert.deepEqual(parseLog(good), [{ sha, committedAt: 1_790_000_000_000, subject: "subject", files: ["file.txt"] }]);
  assert.deepEqual(parseLog(""), []);
  const broken = {
    "no closing NUL": good.slice(0, -1),
    "something before the first NUL": `junk${good}`,
    "an id that is not one": good.replace(sha, "not-an-id"),
    "a time that is not one": good.replace("1790000000", "soon"),
    "a record cut after its time": `\0${sha}\x001790000000\0`,
    "a file list git did not open": `\0${sha}\x001790000000\0subject\0file.txt\0`,
    "an empty file name": `\0${sha}\x001790000000\0subject\0\n\0`,
  };
  for (const [what, text] of Object.entries(broken)) assert.throws(() => parseLog(text), /git log printed/, what);
});

test("an accepted head is missing only when git says so: a folder that is not a repository is a failure", { skip: onlyWindows }, async () => {
  // The bug: a non-zero exit read as "this commit is missing". A folder that stopped being a repository then sends a
  // resync, and the dashboard records the history between as a gap the folder never lost.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-missing-")));
  const repo = join(root, "proj");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  const present = git(repo, "rev-parse", "HEAD");
  const reader = new GitReader({ env: { ...process.env, GIT_CEILING_DIRECTORIES: root } });
  assert.equal(await reader.hasCommit(repo, present), true);
  assert.equal(await reader.hasCommit(repo, "f".repeat(40)), false);
  renameSync(join(repo, ".git"), join(repo, ".git-parked"));
  await assert.rejects(reader.hasCommit(repo, present), /not a git repository/);
});

test("only exit 1 with nothing on stderr reads as missing", async () => {
  // Each limb of the rule, alone: git exits 1 and says nothing for a commit it cannot find (measured, git 2.54).
  const answering = (code, stderr) => new GitReader({ execFile: (file, args, options, callback) => callback(Object.assign(new Error("exited"), { code }), "", stderr) });
  const id = "f".repeat(40);
  assert.equal(await answering(1, "").hasCommit("C:/x", id), false);
  await assert.rejects(answering(128, "").hasCommit("C:/x", id), /failed/, "another exit, silent");
  await assert.rejects(answering(1, "error: unable to read objects\n").hasCommit("C:/x", id), /unable to read/, "exit 1 that says why");
});

test("a failure to look up the accepted head sends no resync and is shown", { skip: onlyWindows }, async (t) => {
  // The bug, end to end: the lookup fails for a reason that is not absence, the plugin reads it as a missing
  // commit, and the dashboard is told to record a gap.
  const s = await setUp(t);
  await s.watcher.tick();
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second");
  const failing = new GitReader({ execFile: (file, args, options, callback) => (args.some((arg) => arg.endsWith("^{commit}"))
    ? callback(Object.assign(new Error("exited"), { code: 128 }), "", "fatal: unable to read objects\n")
    : nodeExecFile(file, args, options, callback)) });
  const watcher = new HeadWatcher({
    api: new DashboardApi({ endpoint: s.dashboard.endpoint, credential: async () => "k" }),
    git: failing,
    machineId: MACHINE,
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [join(s.repo, "..")] }), "win32"), [], "win32"),
    reporter: REPORTER,
    now: () => 1_000_000,
  });
  await watcher.tick();
  assert.match(watcher.state().problems.join("\n"), /unable to read objects/);
  assert.deepEqual(s.dashboard.state.gaps, [], "no gap was recorded");
  assert.equal(s.dashboard.sent.filter((r) => r.url.endsWith("/resync")).length, 0);
});

test("going backwards is a resync named reset; unrelated history is one named unknown; coverage follows the head", { skip: onlyWindows }, async (t) => {
  // The bug: a range opened backwards, or none at all, so a reset leaves the dashboard claiming coverage of
  // commits the folder no longer has.
  const s = await setUp(t);
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second");
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "third");
  await s.watcher.tick();
  git(s.repo, "reset", "-q", "--hard", "HEAD~2");
  await s.tick();
  assert.deepEqual(s.dashboard.state.gaps.map((g) => g.reason), ["reset"]);
  assert.equal(s.dashboard.state.ackedHead, git(s.repo, "rev-parse", "HEAD"));

  git(s.repo, "checkout", "-q", "--orphan", "elsewhere");
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "unrelated");
  await s.tick();
  assert.deepEqual(s.dashboard.state.gaps.map((g) => g.reason), ["reset", "unknown"]);
  assert.equal(s.dashboard.state.ackedHead, git(s.repo, "rev-parse", "HEAD"));
  assert.equal(s.dashboard.state.stored.length, 0, "no commits were invented for either");
  assert.equal(s.watcher.state().resyncs, 2);
});

test("an accepted head this clone does not hold is a resync named missing_object", { skip: onlyWindows }, async (t) => {
  const s = await setUp(t);
  await s.watcher.tick();
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second");
  s.dashboard.state.ackedHead = "f".repeat(40);
  await s.tick();
  assert.deepEqual(s.dashboard.state.gaps.map((g) => g.reason), ["missing_object"]);
  assert.deepEqual(s.watcher.state().problems, []);
});

test("an id from the dashboard that is not a full commit id never reaches git", { skip: onlyWindows }, async (t) => {
  // The bug: handing git an id the dashboard sent. One that began with "-" is read by git as an option.
  const s = await setUp(t);
  await s.watcher.tick();
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second");
  s.dashboard.state.ackedHead = "--output=C:/stolen";
  await s.tick();
  assert.match(s.watcher.state().problems.join("\n"), /is not a full commit id/);
  assert.ok(!s.spawns.some((args) => args.some((arg) => arg.includes("--output"))), "no git process was given it");
});

test("a head report answered without the accepted head fails closed: no commits, and the doctor is told", { skip: onlyWindows }, async (t) => {
  const s = await setUp(t);
  s.dashboard.fail.push({ when: "/reports/head", answer: () => [200, { ok: true }] });
  await s.watcher.tick();
  assert.match(s.watcher.state().problems.join("\n"), /did not say which head it has accepted/);
  assert.equal(s.dashboard.sent.filter((r) => r.url.includes("commit-ranges")).length, 0);
});
