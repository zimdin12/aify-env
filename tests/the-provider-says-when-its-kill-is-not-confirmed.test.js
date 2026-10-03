// A provider client whose process tree could not be confirmed ended is said in the plugin's doctor rows, whether it
// was killed by a stop or by its time running out, and the project is not stopped for it. The rows are what
// `/health` and the doctor show (index.mjs forwards them); the client run is faked, its result is the subject.
//
// The bug (review of a84ed99, S1-F3): the run said "not confirmed ended", and the runner dropped it. A stopped run
// records nothing and a timed-out run is a retry whose row carries no error, so an operator never learnt that the
// client's node or git processes might still be running.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { ProviderRunner, SCRIPT } from "../lib/plugins/aify-dashboard/provider-runner.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const KEY = "dashboard-key-sentinel-7f3a";
const CHECKOUT = "C:/checkout";
const UNCONFIRMED = "the client's process tree was not confirmed ended within 10 s";

/** A runner for one project whose client runs end as `exits` say, one per run; `pending` can be emptied to go idle. */
function setUp(exits) {
  const s = { pending: [{ projectId: "p1", queued: 1 }], runs: 0 };
  s.runner = new ProviderRunner({
    api: { providerPending: async (hostKey) => ({ hostKey, projects: s.pending }) },
    credential: async () => KEY,
    folders: () => [{ projectId: "p1", path: "C:/w/p1", real: "C:/w/p1", platform: "win32" }],
    watchRoots: async () => ({ roots: ["c:/w"], problems: [] }),
    realpath: (path) => path,
    config: () => ({ config: { providerCheckout: CHECKOUT }, problem: "" }),
    endpoint: "http://127.0.0.1:9",
    hostKey: "h",
    reporter: "aify-env:win32:h:r",
    parentEnv: {},
    nodePath: "C:/node/node.exe",
    exists: (path) => path === CHECKOUT || path === join(CHECKOUT, SCRIPT),
    run: async () => {
      s.runs += 1;
      return { code: 0, signal: null, timedOut: false, stopped: false, error: "", unconfirmed: "", ...(exits.shift() ?? {}) };
    },
  });
  s.rows = () => s.runner.state().problems.filter((row) => row.includes("not confirmed ended"));
  return s;
}

test("a stop whose kill was not confirmed is said, and stops nothing", async () => {
  const s = setUp([{ code: null, signal: "SIGKILL", stopped: true, error: UNCONFIRMED, unconfirmed: UNCONFIRMED }]);
  await s.runner.pass();
  const state = s.runner.state();
  assert.equal(state.runs, 0, "a stop is still not a run");
  assert.deepEqual(state.stopped, [], "and not a stop of the project");
  assert.equal(s.rows().length, 1);
  assert.match(s.rows()[0], /^project p1: the provider client was killed when it was stopped, and the client's process tree was not confirmed ended within 10 s: its processes may still be running/);
});

test("a timeout whose kill was not confirmed is said, the project still runs, and the row outlives later passes", async () => {
  const failed = `the client's process tree was not confirmed ended: taskkill refused ${KEY}`;
  const s = setUp([{ code: null, timedOut: true, error: failed, unconfirmed: failed }]);
  await s.runner.pass();
  assert.deepEqual(s.runner.state().stopped, [], "a retry, not a stop");
  assert.match(s.rows()[0] ?? "", /^project p1: the provider client was killed when it ran past its time, and the client's process tree was not confirmed ended: taskkill refused <the dashboard key>/);
  assert.ok(!s.runner.state().problems.join("\n").includes(KEY), "no key in a row");
  // A later run that ends well says nothing about the tree that was not confirmed gone, and neither does an idle pass.
  await s.runner.pass();
  assert.equal(s.runs, 2, "still run");
  s.pending = [];
  await s.runner.pass();
  assert.equal(s.rows().length, 1, "the row stays until aify-env restarts");
});

test("one row per project, naming its latest kill that was not confirmed", async () => {
  const later = "the client's process tree was not confirmed ended: taskkill exited 1";
  const s = setUp([{ code: null, timedOut: true, unconfirmed: UNCONFIRMED }, { code: null, timedOut: true, unconfirmed: later }]);
  await s.runner.pass();
  await s.runner.pass();
  assert.equal(s.rows().length, 1);
  assert.match(s.rows()[0], /taskkill exited 1/);
});

test("through the plugin, the row outlives its stop and start, and a plugin rebuilt in the same process", async (t) => {
  // The bug (review of a84ed99, F3's lifetime): each start builds a new runner, and a registry change builds a new
  // plugin, so rows a runner owned were gone long before aify-env restarted. This uses the plugin's own store, which
  // is one per process, so no other test in this file may leave a row through the plugin.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-unconfirmed-")));
  const checkout = join(root, "apg");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, SCRIPT), "process.exit(0);\n");
  const proj = join(root, "proj").replace(/\\/g, "/");
  mkdirSync(proj);
  // A real repository: a folder is served only once a look has judged where git reads it from.
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "p"]]) execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: proj });
  const endpoint = "http://127.0.0.1:9";
  const fetch = async (url) => {
    const at = String(url);
    if (at.endsWith("/host/h/watch-list")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: proj } }] });
    if (at.endsWith("/host/h/provider/pending")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", queued: 1 }] });
    if (at.endsWith("/reports/head")) return Response.json({ ok: true, ackedHead: "", cursorRevision: 1 });
    return Response.json({ error: "not here", code: "no_route" }, { status: 404 });
  };
  const results = [{ code: null, signal: null, timedOut: true, stopped: false, error: UNCONFIRMED, unconfirmed: UNCONFIRMED }];
  let runs = 0;
  const runChild = async () => { runs += 1; return results.shift() ?? { code: 0, signal: null, timedOut: false, stopped: false, error: "", unconfirmed: "" }; };
  const build = () => createDashboardPlugin({
    name: "aify-dashboard", endpoint, service: { name: "aify-dashboard", endpoint }, machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [root] }), "win32"), [], "win32"),
    config: () => ({ config: { providerCheckout: checkout }, problem: "" }),
  }, { fetch, runChild, runEveryMs: 25, tickMs: 60_000 });
  const host = { credential: async () => KEY };
  const rows = (plugin) => plugin.state().problems.filter((row) => row.includes("not confirmed ended"));
  const waitFor = async (done) => { const until = Date.now() + 30_000; while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10)); };

  const first = build();
  t.after(() => first.stop());
  await first.start(host);
  await waitFor(() => rows(first).length === 1);
  assert.equal(rows(first).length, 1, "the unconfirmed kill is said through the plugin");
  await first.stop();
  assert.equal(rows(first).length, 1, "stopped");
  await first.start(host);
  assert.equal(rows(first).length, 1, "started again, with a new runner");
  await waitFor(() => runs >= 3);
  assert.equal(rows(first).length, 1, "and after runs that ended well");
  await first.stop();
  const second = build();
  t.after(() => second.stop());
  assert.equal(rows(second).length, 1, "a plugin rebuilt in the same process, not yet started");
  await second.start(host);
  await waitFor(() => runs >= 4);
  await second.stop();
  assert.equal(rows(second).length, 1, "and after it has run");
});

test("a kill that was confirmed leaves no such row (the control)", async () => {
  const s = setUp([{ code: null, signal: "SIGKILL", stopped: true }, { code: null, timedOut: true }]);
  await s.runner.pass();
  await s.runner.pass();
  assert.deepEqual(s.rows(), []);
});
