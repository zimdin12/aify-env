// The aify-dashboard plugin sweeping a watched folder's new head with the code provider's sweep client
// (aify-project-graph scripts/post-watch-signals.mjs), so a commit's effect on anchored code reaches the dashboard
// without anyone running it by hand. The client is faked here; when it is started, what it is handed and what its exit
// means are the subject. The exit codes are its owner's (graph-tech-lead, 2026-10-19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { DIRTY_WAIT_MAX_MS, SWEEP_SCRIPT, SweepRunner, sweepOutcomeOf } from "../lib/plugins/aify-dashboard/sweep-runner.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const KEY = "dashboard-key-sentinel-5c1e";
const CHECKOUT = "C:/checkout";
const EXISTING = new Set([CHECKOUT, join(CHECKOUT, SWEEP_SCRIPT)]);
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const MINUTE = 60_000;

async function waitFor(done, ms = 30_000) {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A sweeper whose dashboard, folders, grant, config, clock and client are all plain state a test can change. */
function setUp(overrides = {}) {
  const s = {
    folders: [{ projectId: "p1", path: "C:/w/p1", real: "C:/w/p1", platform: "win32", head: H1 }],
    roots: ["c:/w"],
    config: { providerCheckout: CHECKOUT },
    key: KEY,
    items: [{ watchId: "w1" }],
    answer: undefined,
    exits: [],
    runs: [],
    asked: [],
    at: 1_000_000,
    ...overrides,
  };
  s.runner = new SweepRunner({
    api: {
      watchSet: async (hostKey, projectId) => {
        s.asked.push(projectId);
        return s.answer === undefined ? { watchRevision: "r1", items: s.items } : s.answer;
      },
    },
    credential: async () => s.key,
    folders: () => s.folders,
    watchRoots: async () => ({ roots: s.roots, problems: [] }),
    config: () => (s.config === null ? { config: null, problem: "no section" } : { config: s.config, problem: "" }),
    endpoint: "http://127.0.0.1:9",
    hostKey: "h",
    parentEnv: { PATH: "C:/bin", SystemRoot: "C:/Windows", APG_DASHBOARD_REPORTER: "aify-env:win32:h:from-the-parent", SECRET_SENTINEL: "s3cret" },
    nodePath: "C:/node/node.exe",
    exists: (path) => EXISTING.has(path),
    now: () => s.at,
    run: async (args) => {
      s.runs.push(args);
      const next = s.exits.shift() ?? {};
      return { code: 0, signal: null, timedOut: false, stopped: false, error: "", ...next };
    },
  });
  s.problems = () => s.runner.state().problems.join("\n");
  return s;
}

test("a new head is swept once, in the folder its look judged, and the same head is not swept again", async () => {
  // The bugs: nothing sweeps at all (the sweep was only ever run by hand), or every pass sweeps the same head again.
  const s = setUp();
  await s.runner.pass();
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].script, join(CHECKOUT, SWEEP_SCRIPT));
  assert.equal(s.runs[0].cwd, "C:/w/p1");
  await s.runner.pass();
  assert.equal(s.runs.length, 1, "the same head is not swept twice");
  s.folders[0].head = H2;
  await s.runner.pass();
  assert.equal(s.runs.length, 2, "a new head is swept");
  assert.equal(s.runner.state().runs, 2);
  assert.deepEqual(s.runner.state().problems, []);
});

test("a folder with nothing watched starts no client, and is asked about once per head", async () => {
  // The bug: a process per commit in every registered project, though only a project with anchors has anything to sweep.
  const s = setUp({ items: [] });
  await s.runner.pass();
  await s.runner.pass();
  assert.equal(s.runs.length, 0);
  assert.deepEqual(s.asked, ["p1"], "asked once for that head");
  s.folders[0].head = H2;
  s.items = [{ watchId: "w1" }];
  await s.runner.pass();
  assert.equal(s.runs.length, 1, "a new head is asked about again, and swept once something is watched");
  assert.deepEqual(s.runner.state().problems, []);
});

test("the client is handed no reporter name, so a restarted aify-env continues the same sweep cursor", async () => {
  // The bug: the sweep carries aify-env's per-process reporter, so every restart starts a new cursor and a delayed post
  // from the old process is never ordered against the new one, which is what sweep identity is for.
  const s = setUp();
  await s.runner.pass();
  const env = s.runs[0].env;
  assert.equal(env.APG_DASHBOARD_REPORTER, undefined, "not from the parent, and not from the configuration");
  assert.deepEqual(Object.keys(env).sort(), [
    "APG_DASHBOARD_HOST", "APG_DASHBOARD_KEY", "APG_DASHBOARD_PROJECT", "APG_DASHBOARD_URL",
    "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "PATH", "SystemRoot",
  ]);
  assert.deepEqual([env.APG_DASHBOARD_URL, env.APG_DASHBOARD_KEY, env.APG_DASHBOARD_PROJECT, env.APG_DASHBOARD_HOST],
    ["http://127.0.0.1:9", KEY, "p1", "h"]);
  assert.ok(!JSON.stringify(env).includes("s3cret"));
});

test("exit codes mean what the client's owner said: 0 and 3 settle the head, 4 waits, 2 runs again, anything else is a bug", () => {
  const rows = [
    [{ code: 0 }, "swept"], [{ code: 3 }, "swept"], [{ code: 4 }, "dirty"], [{ code: 2 }, "again"], [{ code: 1 }, "bug"],
    [{ code: 5 }, "bug"], [{ code: null, signal: "SIGKILL" }, "bug"], [{ code: null, timedOut: true }, "retry"],
  ];
  for (const [result, outcome] of rows) assert.equal(sweepOutcomeOf({ timedOut: false, ...result }), outcome, JSON.stringify(result));
});

test("a dirty tree keeps the head waiting and tries again later, each wait longer, until a run at that head is clean", async () => {
  // The bugs: a head committed while other files were still uncommitted is never swept, because once the tree is clean
  // HEAD does not move again; or the dirty tree is swept every minute for as long as someone works.
  const s = setUp({ exits: [{ code: 4 }, { code: 4 }, { code: 0 }] });
  await s.runner.pass();
  assert.equal(s.runs.length, 1);
  s.at += MINUTE / 2;
  await s.runner.pass();
  assert.equal(s.runs.length, 1, "not before the first wait");
  s.at += MINUTE / 2;
  await s.runner.pass();
  assert.equal(s.runs.length, 2, "tried again after a minute");
  s.at += MINUTE;
  await s.runner.pass();
  assert.equal(s.runs.length, 2, "the second wait is longer");
  s.at += MINUTE;
  await s.runner.pass();
  assert.equal(s.runs.length, 3, "and tried again after it");
  s.at += DIRTY_WAIT_MAX_MS;
  await s.runner.pass();
  assert.equal(s.runs.length, 3, "a clean run settled the head");
  assert.deepEqual(s.runner.state().problems, [], "a dirty tree is ordinary work, not a problem");
});

test("the wait for a clean tree is capped, and a new head is swept at once whatever was waiting", async () => {
  const s = setUp({ exits: Array.from({ length: 12 }, () => ({ code: 4 })) });
  for (let i = 0; i < 10; i += 1) {
    await s.runner.pass();
    s.at += DIRTY_WAIT_MAX_MS;
  }
  assert.equal(s.runs.length, 10, "never waits longer than the cap");
  await s.runner.pass();
  assert.equal(s.runs.length, 11, "dirty again, so the old head now waits a whole cap");
  // Inside that wait, not after it: a check made once the wait is over cannot tell a new head from the old one's turn.
  s.folders[0].head = H2;
  s.at += 1;
  await s.runner.pass();
  assert.equal(s.runs.length, 12, "the new head replaces the waiting one without waiting");
});

test("a refusal runs again, and three in a row at one head stop that folder with a row until its configuration changes", async () => {
  // The bugs: a refused post never retried (2 means reserve afresh), or retried every minute for ever.
  const s = setUp({ exits: [{ code: 2 }, { code: 2 }, { code: 2, error: "refused: inconsistent" }] });
  await s.runner.pass();
  await s.runner.pass();
  assert.deepEqual(s.runner.state().problems, [], "a refusal is retried before it is a problem");
  await s.runner.pass();
  assert.equal(s.runs.length, 3);
  assert.match(s.problems(), /project p1: the sweep client was refused 3 times in a row at 1{40}.*\(refused: inconsistent\)/);
  await s.runner.pass();
  assert.equal(s.runs.length, 3, "stopped");
  s.config = { providerCheckout: CHECKOUT, edited: true };
  await s.runner.pass();
  assert.equal(s.runs.length, 4, "an edited section lifts the stop");
});

test("refusals stop one head, not the folder: a new head is swept with the configuration unchanged", async () => {
  // The bug (dashboard-senior-dev, on c312f5c): three transient refusals at H1 latched the folder, so a usable H2 was
  // never swept until someone edited the configuration or restarted aify-env.
  const s = setUp({ exits: [{ code: 2 }, { code: 2 }, { code: 2 }] });
  for (let i = 0; i < 3; i += 1) await s.runner.pass();
  assert.equal(s.runs.length, 3);
  assert.match(s.problems(), /refused 3 times in a row at 1{40}/);
  s.folders[0].head = H2;
  await s.runner.pass();
  assert.equal(s.runs.length, 4, "the new head is swept");
  assert.deepEqual(s.runner.state().problems, [], "and the old head's row is gone with it");
});

test("a bug stops the folder with a row, a stale sweep settles the head, and the key never reaches a row", async () => {
  const b = setUp({ exits: [{ code: 1, error: `POST refused for x-api-key ${KEY}` }] });
  await b.runner.pass();
  b.folders[0].head = H2;
  await b.runner.pass();
  assert.equal(b.runs.length, 1, "a bug is not run again, even for a new head");
  assert.match(b.problems(), /project p1: the sweep client stopped with exit 1 \(a bug\).*POST refused for x-api-key <the dashboard key>/);
  assert.ok(!b.problems().includes(KEY));

  const stale = setUp({ exits: [{ code: 3 }] });
  await stale.runner.pass();
  await stale.runner.pass();
  assert.equal(stale.runs.length, 1, "3 is a later sweep already applied: nothing to do at this head");
  assert.deepEqual(stale.runner.state().problems, []);
});

test("a run past its time is tried again, and says so once it repeats", async () => {
  const s = setUp({ exits: [{ code: null, timedOut: true }, { code: null, timedOut: true }, {}] });
  await s.runner.pass();
  assert.deepEqual(s.runner.state().problems, []);
  await s.runner.pass();
  assert.match(s.problems(), /project p1: the sweep client ran past its time 2 times in a row/);
  await s.runner.pass();
  assert.equal(s.runs.length, 3);
  assert.deepEqual(s.runner.state().problems, [], "a run that ends clears it");
});

test("nothing is swept where the grant no longer reaches, and a folder with no reported head is left alone", async () => {
  const s = setUp({ roots: ["c:/other"] });
  await s.runner.pass();
  assert.equal(s.runs.length, 0);
  assert.match(s.problems(), /project p1: C:\/w\/p1 is not inside the grant as it stands now, so it is not swept/);

  const unreported = setUp();
  unreported.folders[0].head = "";
  await unreported.runner.pass();
  assert.equal(unreported.runs.length, 0);
  assert.deepEqual(unreported.asked, [], "not even asked about");
});

test("an answer about the watch set in the wrong shape is a problem, never \"nothing watched\"", async () => {
  // The bug: a malformed answer read as an empty set, so the head is settled unswept and never looked at again.
  for (const answer of [null, {}, { items: "w1" }, { watchRevision: "r", items: null }]) {
    const s = setUp({ answer });
    await s.runner.pass();
    assert.equal(s.runs.length, 0, JSON.stringify(answer));
    assert.match(s.problems(), /project p1: the dashboard's answer about its watch set was not the shape it should be/, JSON.stringify(answer));
    s.answer = undefined;
    await s.runner.pass();
    assert.equal(s.runs.length, 1, `the head was not settled by the bad answer: ${JSON.stringify(answer)}`);
  }
});

test("no checkout, or no credential, starts nothing and says why", async () => {
  const none = setUp({ config: {} });
  await none.runner.pass();
  assert.equal(none.runs.length, 0);
  assert.match(none.problems(), /no plugins\["aify-dashboard"\]\.providerCheckout is set/);
  const nokey = setUp({ key: "" });
  await nokey.runner.pass();
  assert.equal(nokey.runs.length, 0);
  assert.match(nokey.problems(), /project p1: no credential for aify-dashboard on this host, so the sweep client was not started/);
});

test("a stop during a run records nothing", async () => {
  const s = setUp({ exits: [{ code: null, signal: "SIGKILL", stopped: true }] });
  await s.runner.pass();
  assert.deepEqual(s.runner.state(), { runs: 0, stopped: [], problems: [] });
});

test("through the plugin: a watched folder's head is swept after the provider's pass, and stop ends the loop", async (t) => {
  // The bugs: the sweeper never wired into the plugin, handed a folder whose head the watcher never reported, or run
  // under aify-env's reporter name.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-sweep-")));
  const checkout = join(root, "apg");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, SWEEP_SCRIPT), "process.exit(0);\n");
  const proj = join(root, "proj").replace(/\\/g, "/");
  mkdirSync(proj);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "init", "-q"], { cwd: proj });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "p"], { cwd: proj });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: proj, encoding: "utf8" }).trim();
  const endpoint = "http://127.0.0.1:9";
  const fetch = async (url) => {
    const at = String(url);
    if (at.endsWith("/host/h/watch-list")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: proj } }] });
    if (at.endsWith("/host/h/provider/pending")) return Response.json({ hostKey: "h", projects: [] });
    if (at.endsWith("/host/h/projects/p1/watch-set")) return Response.json({ watchRevision: "r1", items: [{ watchId: "w1" }] });
    if (at.endsWith("/reports/head")) return Response.json({ ok: true, ackedHead: head, cursorRevision: 1 });
    return Response.json({ error: "not here", code: "no_route" }, { status: 404 });
  };
  const runs = [];
  const runChild = async (args) => { runs.push(args); return { code: 0, signal: null, timedOut: false, stopped: false, error: "" }; };
  const plugin = createDashboardPlugin({
    name: "aify-dashboard", endpoint, service: { name: "aify-dashboard", endpoint }, machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [root] }), "win32"), [], "win32"),
    config: () => ({ config: { providerCheckout: checkout }, problem: "" }),
  }, { fetch, runChild, runEveryMs: 25, tickMs: 25 });
  t.after(() => plugin.stop());
  await plugin.start({ credential: async () => KEY });
  await waitFor(() => runs.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await plugin.stop();
  assert.equal(runs.length, 1, `swept ${runs.length} times: once for its one head`);
  assert.equal(runs[0].script, join(checkout, SWEEP_SCRIPT));
  assert.equal(runs[0].cwd, realpathSync.native(proj));
  assert.equal(runs[0].env.APG_DASHBOARD_PROJECT, "p1");
  assert.equal(runs[0].env.APG_DASHBOARD_REPORTER, undefined);
  assert.equal(plugin.state().provider.sweeps, 1);
  const after = runs.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runs.length, after, "no pass after stop");
});
