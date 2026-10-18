// The files tracked at a folder's HEAD, sent to aify-dashboard only when its head report asks (aify-dashboard
// docs/DESIGN-FILE-LIST.md, with comms-tech-lead's bounds B1-B4). End to end against a real HTTP server, real
// repositories and real git for the watcher; the paging and decoding rules directly, since they are pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DashboardApi, DashboardApiError } from "../lib/plugins/aify-dashboard/dashboard-api.mjs";
import { decodeTree, FileListSender, MAX_LIST_FILES, MAX_PAGE_BYTES, MAX_PAGE_FILES, pagesOf } from "../lib/plugins/aify-dashboard/file-list.mjs";
import { GitReader, GitReadError } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher, TICK_MS } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const onlyWindows = process.platform !== "win32" && "the dashboard resolves Windows folders only, so this slice watches only them";
const MACHINE = "win32:test-host";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const slashed = (path) => path.replace(/\\/g, "/");

/** A dashboard that asks for a list as `answers.wanted` says, holds what it is sent, and records every request. */
async function fakeDashboard(listed) {
  const requests = [];
  const answers = { wanted: [], list: [] };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = text ? JSON.parse(text) : null;
      requests.push({ method: request.method, url: request.url, body });
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET" && request.url === "/api/v1/host/test-host/watch-list") {
        return send(200, { hostKey: "test-host", projects: listed.map((path, i) => ({ projectId: `p${i}`, name: `n${i}`, root: { fsNamespace: "windows", path: slashed(path) } })) });
      }
      if (request.method === "POST" && request.url === "/reports/head") {
        return send(200, { ok: true, outcome: "moved", ackedHead: body.head, cursorRevision: requests.length, fileListWanted: answers.wanted.shift() ?? false });
      }
      if (request.method === "POST" && request.url === "/reports/file-list") {
        const status = answers.list.shift() ?? 200;
        if (status !== 200) return send(status, { error: "refused for the test", code: status === 409 ? "stale_head" : "test" });
        return send(200, { ok: true, complete: body.page === body.pages - 1, received: body.page + 1, pages: body.pages });
      }
      send(404, { error: "no such route" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, answers, close: () => new Promise((resolve) => server.close(resolve)) };
}

function setUp(t, { trackedFiles } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-list-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const granted = join(root, "granted");
  mkdirSync(granted);
  const watched = join(granted, "proj");
  mkdirSync(join(watched, "dir"), { recursive: true });
  git(watched, "init", "-q");
  writeFileSync(join(watched, "a.txt"), "a");
  writeFileSync(join(watched, "dir", "b.txt"), "b");
  git(watched, "add", ".");
  git(watched, "commit", "-q", "-m", "first");
  const spawns = [];
  const counting = (file, args, options, callback) => {
    spawns.push(args[0]);
    return nodeExecFile(file, args, options, callback);
  };
  const real = new GitReader({ execFile: counting });
  // The real reader, with only its tree read replaceable, so a test can make git fail at exactly that step.
  const reader = trackedFiles === undefined ? real
    : new Proxy(real, { get: (target, name) => (name === "trackedFiles" ? (...args) => trackedFiles(target, ...args) : target[name].bind(target)) });
  const clock = { at: 1_000_000 };
  return {
    watched, spawns, clock,
    async watcher(dashboard) {
      t.after(() => dashboard.close());
      return new HeadWatcher({
        api: new DashboardApi({ endpoint: dashboard.endpoint, credential: async () => "key-1" }),
        git: reader,
        machineId: MACHINE,
        watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [granted] }), "win32"), [], "win32"),
        reporter: "aify-env:win32:test-host:one",
        now: () => clock.at,
      });
    },
  };
}

const lists = (requests) => requests.filter((r) => r.url === "/reports/file-list");
const heads = (requests) => requests.filter((r) => r.url === "/reports/head");

test("the list is sent when a head report asks, never on an idle tick, and for a new head only when asked again", { skip: onlyWindows }, async (t) => {
  const s = setUp(t);
  const dashboard = await fakeDashboard([s.watched]);
  dashboard.answers.wanted.push(true);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();
  const [sent] = lists(dashboard.requests);
  assert.deepEqual(sent?.body, {
    machineId: MACHINE, worktree: { raw: slashed(s.watched), canonical: slashed(s.watched) }, head: git(s.watched, "rev-parse", "HEAD"),
    bridgeInstanceId: "aify-env:win32:test-host:one", page: 0, pages: 1, files: ["a.txt", "dir/b.txt"], unencodable: 0,
  });
  assert.equal(watcher.state().listsSent, 1);

  // Bug this catches: the list sent, or git run, on every tick.
  const spawned = s.spawns.length;
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(lists(dashboard.requests).length, 1, "an idle tick sent the list again");
  assert.equal(s.spawns.length, spawned, "an idle tick ran git");

  // The control, same run: a moved HEAD the dashboard does not ask about sends nothing, and one it asks about does.
  git(s.watched, "commit", "-q", "--allow-empty", "-m", "second");
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(lists(dashboard.requests).length, 1, "a head the dashboard did not ask about was listed");
  git(s.watched, "commit", "-q", "--allow-empty", "-m", "third");
  dashboard.answers.wanted.push(true);
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(lists(dashboard.requests).length, 2);
  assert.equal(lists(dashboard.requests)[1].body.head, git(s.watched, "rev-parse", "HEAD"));
});

test("the list is the commit's, never the working tree's", { skip: onlyWindows }, async (t) => {
  // Bug this catches: listing the working tree. An untracked file would appear, and a committed file deleted on disk
  // would vanish, so the tree would describe a state no commit has.
  const s = setUp(t);
  writeFileSync(join(s.watched, "untracked.txt"), "x");
  rmSync(join(s.watched, "a.txt"));
  const dashboard = await fakeDashboard([s.watched]);
  dashboard.answers.wanted.push(true);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();
  assert.deepEqual(lists(dashboard.requests)[0]?.body.files, ["a.txt", "dir/b.txt"]);
});

test("a dashboard that refuses or does not answer is tried again next tick; a stale head drops the list", { skip: onlyWindows }, async (t) => {
  const s = setUp(t);
  const dashboard = await fakeDashboard([s.watched]);
  dashboard.answers.wanted.push(true);
  dashboard.answers.list.push(503);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();
  assert.match(watcher.state().problems.join("\n"), /503/);
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(lists(dashboard.requests).length, 2, "a refused list was not sent again");
  assert.equal(watcher.state().listsSent, 1);
  assert.deepEqual(watcher.state().problems, []);

  // 409 stale_head: dropped, not retried, and not a problem; the next head report asks again.
  const again = setUp(t);
  const stale = await fakeDashboard([again.watched]);
  stale.answers.wanted.push(true);
  stale.answers.list.push(409);
  const dropping = await again.watcher(stale);
  await dropping.tick();
  again.clock.at += TICK_MS;
  await dropping.tick();
  assert.equal(lists(stale.requests).length, 1, "a list for a stale head was sent again");
  assert.deepEqual(dropping.state().problems, []);
});

test("git that cannot list a head is one problem line and is not run again for that head", { skip: onlyWindows }, async (t) => {
  // Bug this catches (B3): a broken or slow tree re-run on every tick.
  let calls = 0;
  const s = setUp(t, { trackedFiles: async () => { calls += 1; throw new GitReadError("git ls-tree timed out"); } });
  const dashboard = await fakeDashboard([s.watched]);
  dashboard.answers.wanted.push(true);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();
  s.clock.at += TICK_MS;
  await watcher.tick();
  // The branch's ref file touched, at the same commit: the fingerprint moves, so the folder is looked at in full again,
  // and HEAD has not moved, so nothing asks for the list afresh. That look is the one that must not run git ls-tree
  // again. (`git update-ref` to the same value leaves the file alone, so the time is set directly.)
  const ref = join(s.watched, ".git", git(s.watched, "symbolic-ref", "HEAD"));
  const later = new Date(Date.now() + 60_000);
  utimesSync(ref, later, later);
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(calls, 1, "the failed tree read was run again for the same head");
  assert.equal(lists(dashboard.requests).length, 0);
  assert.equal(watcher.state().problems.filter((line) => /were not sent: git ls-tree timed out/.test(line)).length, 1);
});

/** Move the folder's fingerprint without moving HEAD: the branch ref file's time is set. */
function touchRef(watched) {
  const ref = join(watched, ".git", git(watched, "symbolic-ref", "HEAD"));
  const later = new Date(Date.now() + 120_000 + Math.floor(Math.random() * 60_000));
  utimesSync(ref, later, later);
}

test("a list sent, withheld or dropped as stale is not sent again when the folder is looked at again at the same head", { skip: onlyWindows }, async (t) => {
  // Bug this catches (comms-senior-dev, R3 on cae36a2): the ask kept after its answer, so a look that the fingerprint
  // forced, with HEAD unmoved and so no new head report, sent the list again from the old ask.
  const huge = Buffer.from(`${Array.from({ length: MAX_LIST_FILES + 1 }, (_, i) => `f${i}`).join("\0")}\0`);
  for (const [outcome, options, status] of [["sent", {}, 200], ["withheld", { trackedFiles: async () => huge }, 200], ["stale", {}, 409]]) {
    const s = setUp(t, options);
    const dashboard = await fakeDashboard([s.watched]);
    dashboard.answers.wanted.push(true);
    dashboard.answers.list.push(status);
    const watcher = await s.watcher(dashboard);
    await watcher.tick();
    assert.equal(lists(dashboard.requests).length, 1, `${outcome}: nothing was sent at first`);
    touchRef(s.watched);
    s.clock.at += TICK_MS;
    await watcher.tick();
    assert.equal(heads(dashboard.requests).length, 1, `${outcome}: the forced look reported the head again, so it cannot test the old ask`);
    assert.equal(lists(dashboard.requests).length, 1, `${outcome}: the list was sent again from an ask already answered`);
  }
});

test("a git failure's problem line stays while its latch holds, through a re-sync, and clears once a new head is listed", { skip: onlyWindows }, async (t) => {
  // Bug this catches (comms-senior-dev, R4 on cae36a2): forgetReported re-reports the same head, which cleared the
  // problem line while the latch still kept that head unlisted, so health read clean with the list absent.
  let calls = 0;
  const s = setUp(t, { trackedFiles: async (real, ...args) => { calls += 1; if (calls === 1) throw new GitReadError("git ls-tree timed out"); return real.trackedFiles(...args); } });
  const dashboard = await fakeDashboard([s.watched]);
  dashboard.answers.wanted.push(true, true, true);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();
  watcher.forgetReported();
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(heads(dashboard.requests).length, 2, "the re-sync did not report the head again, so it cannot test the latch");
  assert.equal(calls, 1, "the latched head was listed again after the re-sync");
  assert.equal(watcher.state().problems.filter((line) => /were not sent: git ls-tree timed out/.test(line)).length, 1, "the re-sync hid the failure");

  // The control: a new head is listed, and the line goes.
  git(s.watched, "commit", "-q", "--allow-empty", "-m", "second");
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(calls, 2);
  assert.equal(lists(dashboard.requests).length, 1);
  assert.deepEqual(watcher.state().problems, []);
});

test("a page closes at the count bound or the size bound, whichever comes first, and keeps the order", () => {
  // Bug this catches (B1): a page over the dashboard's limit, which it refuses whole.
  const short = Array.from({ length: 4_500 }, (_, i) => `f${i}.ts`);
  assert.deepEqual(pagesOf(short).map((page) => page.length), [MAX_PAGE_FILES, MAX_PAGE_FILES, 500]);
  assert.deepEqual(pagesOf(short).flat(), short);
  const long = Array.from({ length: 600 }, (_, i) => `${"d".repeat(3_000)}/${i}.ts`);
  const pages = pagesOf(long);
  assert.ok(pages.length > 1, "long paths were not paged by size");
  const bytesOf = (page) => Buffer.byteLength(JSON.stringify(page), "utf8");
  for (const page of pages) assert.ok(bytesOf(page) <= MAX_PAGE_BYTES, `a page of ${bytesOf(page)} bytes`);
  assert.deepEqual(pages.flat(), long);
  // At the edge: a page exactly at the bound is kept whole, one byte more closes it.
  const exact = ["x".repeat(MAX_PAGE_BYTES - 4)];
  assert.equal(bytesOf(exact), MAX_PAGE_BYTES);
  assert.deepEqual(pagesOf([...exact, "y"]).map((page) => page.length), [1, 1]);
  // Bytes, not characters (dashboard-senior-dev, ea19107 finding 2): three-byte characters fill a page three times as
  // fast, and a page measured in characters would be refused by the dashboard whole.
  const euros = Array.from({ length: 100 }, (_, i) => `${"€".repeat(2_000)}/${i}.ts`);
  assert.ok(JSON.stringify(euros).length < MAX_PAGE_BYTES, "the fixture fits in characters, so it cannot tell bytes from characters");
  const euroPages = pagesOf(euros);
  assert.ok(euroPages.length > 1, "a page over the bound in bytes was kept whole");
  for (const page of euroPages) assert.ok(bytesOf(page) <= MAX_PAGE_BYTES, `a page of ${bytesOf(page)} bytes`);
});

test("a path that is not UTF-8 is counted, never sent under another name", () => {
  // Bug this catches (B4): a lossy decode, which sends a path no file has.
  const bytes = Buffer.concat([Buffer.from("a.txt\0"), Buffer.from([0xff, 0xfe, 0x2e, 0x74, 0]), Buffer.from("dir/b.txt\0")]);
  assert.deepEqual(decodeTree(bytes), { files: ["a.txt", "dir/b.txt"], unencodable: 1 });
  assert.deepEqual(decodeTree(Buffer.from("ok\0trunc")), { files: ["ok"], unencodable: 1 }, "a truncated last entry was sent");
});

test("a name that begins with a byte-order mark keeps it, so it stays a different file", () => {
  // Bug this catches (comms-senior-dev, R2 on cae36a2): a decoder that strips a leading U+FEFF, which turns
  // "<BOM>a.txt" into "a.txt" beside the real "a.txt", and the dashboard then holds one file for two.
  const bom = String.fromCharCode(0xfeff);
  const bytes = Buffer.from(`${bom}a.txt\0a.txt\0${bom}\0`, "utf8");
  assert.equal(bytes[0], 0xef, "the fixture does not start with the BOM's UTF-8 bytes");
  assert.deepEqual(decodeTree(bytes), { files: [`${bom}a.txt`, "a.txt", bom], unencodable: 0 });
  // The control, same run: an invalid byte beside them is still counted, not decoded.
  assert.deepEqual(decodeTree(Buffer.concat([bytes, Buffer.from([0xc3, 0])])).unencodable, 1);
});

test("a list over the ceiling is withheld with its count, and an empty commit still sends one empty page", async () => {
  // Bug this catches (B2): dozens of pages from one grant, or an empty tree read as no answer at all.
  const sent = [];
  const api = { sendFileList: async (body) => { sent.push(body); return { ok: true }; } };
  const huge = Buffer.from(`${Array.from({ length: MAX_LIST_FILES + 1 }, (_, i) => `f${i}`).join("\0")}\0`);
  const sender = (bytes) => new FileListSender({ api, git: { trackedFiles: async () => bytes }, machineId: MACHINE, reporter: "r" });
  const head = "0".repeat(40);
  assert.deepEqual(await sender(huge).send({ path: "C:/p", places: {}, head }), { kind: "withheld", files: MAX_LIST_FILES + 1 });
  assert.deepEqual(sent[0].withheld, { reason: "too_large", fileCount: MAX_LIST_FILES + 1 });
  assert.equal(sent[0].files, undefined, "a withheld list sent paths");

  // One path longer than a whole page (comms-senior-dev, R1 on cae36a2: git 2.54 stores a 525,000-byte name) cannot be
  // paged, and the dashboard refuses an over-size page whole, so the list is withheld as unpageable rather than sent.
  const longName = Buffer.from(`ok.txt\0${"n".repeat(525_000)}\0`);
  const before = sent.length;
  assert.deepEqual(await sender(longName).send({ path: "C:/p", places: {}, head }), { kind: "withheld", files: 2 });
  assert.deepEqual(sent.slice(before).map((body) => body.withheld), [{ reason: "unpageable", fileCount: 2 }], "a page over the bound was sent");
  await sender(Buffer.alloc(0)).send({ path: "C:/p", places: {}, head });
  const empty = sent[sent.length - 1];
  assert.deepEqual([empty.page, empty.pages, empty.files], [0, 1, []]);

  // A stale head is answered as stale, not thrown: the caller drops the list.
  const staleApi = { sendFileList: async () => { throw new DashboardApiError("stale", { status: 409, code: "stale_head", kind: "answered" }); } };
  const stale = new FileListSender({ api: staleApi, git: { trackedFiles: async () => Buffer.from("a\0") }, machineId: MACHINE, reporter: "r" });
  assert.deepEqual(await stale.send({ path: "C:/p", places: {}, head }), { kind: "stale" });
});
