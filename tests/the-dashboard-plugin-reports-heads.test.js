// The aify-dashboard plugin's watcher, end to end: a real HTTP server standing in for the dashboard,
// real repositories, real git. Every git process is counted, so "an idle workspace costs no process" is
// measured, not claimed.
//
// THE CONFOUNDER IS ALWAYS PRESENT: a second repository the dashboard lists but the operator did not
// grant. A watcher that read every listed folder would report it, and spawn git in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DashboardApi } from "../lib/plugins/aify-dashboard/dashboard-api.mjs";
import { GitReader } from "../lib/plugins/aify-dashboard/git-reader.mjs";
import { HeadWatcher, LIST_EVERY_MS, TICK_MS } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { watchRootsFrom } from "../lib/watch-roots.mjs";

const onlyWindows = process.platform !== "win32" && "the dashboard resolves Windows folders only, so this slice watches only them";
const MACHINE = "win32:test-host";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const slashed = (path) => path.replace(/\\/g, "/");

function repo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

/** A dashboard that answers the watch list and head reports as told, and records every request. */
async function fakeDashboard(listed) {
  const requests = [];
  const answers = { list: 200, head: [] };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, key: request.headers["x-api-key"], body: text ? JSON.parse(text) : null });
      const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (request.method === "GET" && request.url === "/api/v1/host/test-host/watch-list") {
        if (answers.list !== 200) return send(answers.list, { error: "down for the test", code: "test" });
        return send(200, { hostKey: "test-host", projects: listed.map((path, i) => ({ projectId: `p${i}`, name: `n${i}`, root: { fsNamespace: "windows", path: slashed(path) } })) });
      }
      if (request.method === "POST" && request.url === "/reports/head") {
        const status = answers.head.shift() ?? 200;
        if (status === 409) return send(409, { error: "another plugin instance is already reporting this folder", code: "another_reporter" });
        return send(status, { ok: true });
      }
      send(404, { error: "no such route" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, answers, close: () => new Promise((resolve) => server.close(resolve)) };
}

function setUp(t, { grant } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-watch-")));
  const granted = join(root, "granted");
  mkdirSync(granted);
  const watched = repo(granted, "proj");
  const outside = repo(root, "not-granted");
  const spawns = [];
  const counting = (file, args, options, callback) => {
    spawns.push(slashed(options.cwd));
    return nodeExecFile(file, args, options, callback);
  };
  const clock = { at: 1_000_000 };
  const credential = { value: "key-1" };
  return {
    root, watched, outside, spawns, clock, credential,
    async watcher(dashboard) {
      t.after(() => dashboard.close());
      return new HeadWatcher({
        api: new DashboardApi({ endpoint: dashboard.endpoint, credential: async () => credential.value }),
        git: new GitReader({ execFile: counting }),
        machineId: MACHINE,
        watchRoots: async () => grant ?? watchRootsFrom(JSON.stringify({ watchRoots: [granted] }), "win32"),
        reporter: "aify-env:win32:test-host:one",
        now: () => clock.at,
      });
    },
  };
}

const heads = (requests) => requests.filter((r) => r.url === "/reports/head");

test("a baseline is reported once, an idle tick runs no git, and a commit is reported with the key of that moment", { skip: onlyWindows }, async (t) => {
  const s = setUp(t);
  const dashboard = await fakeDashboard([s.watched, s.outside]);
  const watcher = await s.watcher(dashboard);

  await watcher.tick();
  const [first] = heads(dashboard.requests);
  assert.deepEqual(first.body, {
    machineId: MACHINE, worktree: { raw: slashed(s.watched), canonical: slashed(s.watched) },
    head: git(s.watched, "rev-parse", "HEAD"), bridgeInstanceId: "aify-env:win32:test-host:one",
  });
  assert.equal(first.key, "key-1");
  assert.equal(heads(dashboard.requests).length, 1, "the folder outside the grant is not reported");
  assert.ok(!s.spawns.includes(slashed(s.outside)), "and git never ran in it");
  assert.match(watcher.state().problems.join("\n"), /not-granted is not read: it is outside every granted folder/);

  // The bug this catches: running git on every tick. Two hundred folders every ten seconds is the load
  // the stat fingerprint exists to avoid.
  const spawnsAfterBaseline = s.spawns.length;
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.equal(s.spawns.length, spawnsAfterBaseline, "an idle tick spawns no git");
  assert.equal(heads(dashboard.requests).length, 1, "and reports nothing");

  git(s.watched, "commit", "-q", "--allow-empty", "-m", "second");
  s.credential.value = "key-2";
  s.clock.at += TICK_MS;
  await watcher.tick();
  const moved = heads(dashboard.requests)[1];
  assert.equal(moved?.body.head, git(s.watched, "rev-parse", "HEAD"));
  assert.equal(moved.key, "key-2", "a rotated key reaches the next request without a restart");
});

test("a failed refresh keeps the last good list, and a refused report is a problem that is tried again", { skip: onlyWindows }, async (t) => {
  const s = setUp(t);
  const dashboard = await fakeDashboard([s.watched]);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();

  // The bug: a refresh failure read as "nothing to watch", which stops every report.
  dashboard.answers.list = 503;
  git(s.watched, "commit", "-q", "--allow-empty", "-m", "second");
  s.clock.at += LIST_EVERY_MS;
  await watcher.tick();
  assert.equal(dashboard.requests.filter((r) => r.method === "GET").length, 2, "the refresh was attempted");
  assert.equal(heads(dashboard.requests).at(-1).body.head, git(s.watched, "rev-parse", "HEAD"), "the folder is still watched");
  assert.match(watcher.state().problems.join("\n"), /was not refreshed .*503.*still watching the last good list/);

  // The bug: a refused report recorded here as sent, so the head is never reported again.
  git(s.watched, "commit", "-q", "--allow-empty", "-m", "third");
  dashboard.answers.head.push(409);
  s.clock.at += TICK_MS;
  await watcher.tick();
  assert.match(watcher.state().problems.join("\n"), /409: another plugin instance/);
  s.clock.at += TICK_MS;
  await watcher.tick();
  const retried = heads(dashboard.requests).slice(-2);
  assert.equal(retried.length, 2);
  assert.equal(retried[0].body.head, retried[1].body.head, "the refused head is sent again");
  assert.doesNotMatch(watcher.state().problems.join("\n"), /409/, "and the problem clears once it is taken");
});

test("with no grant, nothing is read, and the doctor is told what to add", { skip: onlyWindows }, async (t) => {
  // The bug: defaulting to some folder when the operator granted none.
  const s = setUp(t, { grant: watchRootsFrom(null, "win32") });
  const dashboard = await fakeDashboard([s.watched]);
  const watcher = await s.watcher(dashboard);
  await watcher.tick();
  assert.equal(s.spawns.length, 0);
  assert.equal(heads(dashboard.requests).length, 0);
  const problems = watcher.state().problems.join("\n");
  assert.match(problems, /no watchRoots granted in ~\/\.aify\/config\.json/);
  assert.match(problems, /proj is not read: no folder is granted/);
});
