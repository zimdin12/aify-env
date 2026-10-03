// The aify-dashboard plugin starting the code provider's queue client (aify-project-graph
// scripts/serve-provider-requests.mjs) for this host's projects that have calls queued. The client is faked here;
// what it is handed and what its exit means are the subject. The real process tree is in
// the-provider-client-ends-with-everything-it-started.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { childEnv } from "../lib/plugins/aify-dashboard/provider-child.mjs";
import { outcomeOf, ProviderRunner, SCRIPT } from "../lib/plugins/aify-dashboard/provider-runner.mjs";
import { grantedRoots, watchRootsFrom } from "../lib/watch-roots.mjs";

const KEY = "dashboard-key-sentinel-7f3a";
const CHECKOUT = "C:/checkout";
const EXISTING = new Set([CHECKOUT, join(CHECKOUT, SCRIPT), "C:/empty"]);

/** A runner whose dashboard, folders, grant, config and client are all plain state a test can change between passes. */
function setUp(overrides = {}) {
  const s = {
    pending: [{ projectId: "p1", queued: 2 }],
    folders: [{ projectId: "p1", path: "C:/w/p1", platform: "win32" }],
    roots: ["c:/w"],
    config: { providerCheckout: CHECKOUT },
    key: KEY,
    answer: undefined,
    exits: [],
    runs: [],
    configReads: 0,
    ...overrides,
  };
  s.runner = new ProviderRunner({
    api: { providerPending: async (hostKey) => (s.answer === undefined ? { hostKey, projects: s.pending } : s.answer) },
    credential: async () => s.key,
    folders: () => s.folders,
    watchRoots: async () => ({ roots: s.roots, problems: [] }),
    config: () => {
      s.configReads += 1;
      return s.config === null ? { config: null, problem: "~/.aify/config.json has no plugins[\"aify-dashboard\"] section" } : { config: s.config, problem: "" };
    },
    endpoint: "http://127.0.0.1:9",
    hostKey: "h",
    reporter: "aify-env:win32:h:r",
    parentEnv: { PATH: "C:/bin", SystemRoot: "C:/Windows", SECRET_SENTINEL: "s3cret", AIFY_COMMS_KEY: "comms-key" },
    nodePath: "C:/node/node.exe",
    exists: (path) => EXISTING.has(path),
    run: async (args) => {
      s.runs.push(args);
      const next = s.exits.shift() ?? {};
      next.during?.(s);
      return { code: 0, signal: null, timedOut: false, stopped: false, error: "", ...next };
    },
  });
  s.problems = () => s.runner.state().problems.join("\n");
  return s;
}

test("an idle host starts nothing, reads no configuration, and shows no row", async () => {
  // The bug: a host that never uses the provider carries a standing doctor row about a checkout nobody asked for.
  const s = setUp({ pending: [], config: null });
  await s.runner.pass();
  assert.equal(s.runs.length, 0);
  assert.equal(s.configReads, 0);
  assert.deepEqual(s.runner.state().problems, []);
});

test("a checkout that is not granted exactly starts nothing, and says why", async () => {
  // The checkout names a script aify-env will execute, so every way it can be wrong fails closed, each alone.
  const rows = [
    [null, /has no plugins\["aify-dashboard"\] section/],
    [{}, /no plugins\["aify-dashboard"\]\.providerCheckout is set/],
    [{ providerCheckout: "relative/checkout" }, /must be an absolute folder/],
    [{ providerCheckout: 5 }, /must be an absolute folder, not 5/],
    [{ providerCheckout: "C:/missing" }, /names C:\/missing, which does not exist/],
    [{ providerCheckout: "C:/empty" }, /C:\/empty has no scripts\/serve-provider-requests\.mjs/],
  ];
  for (const [config, why] of rows) {
    const s = setUp({ config });
    await s.runner.pass();
    assert.equal(s.runs.length, 0, JSON.stringify(config));
    assert.match(s.problems(), why, JSON.stringify(config));
    assert.match(s.problems(), /1 project\(s\) have code-provider calls queued, and none is served/);
  }
});

test("a client runs only in a folder listed for its project and granted now", async () => {
  // The bugs: a client started in a folder the operator did not grant, or one listed for another project.
  for (const [folders, roots] of [
    [[{ projectId: "p2", path: "C:/w/p2", platform: "win32" }], ["c:/w"]],
    [[{ projectId: "p1", path: "C:/elsewhere/p1", platform: "win32" }], ["c:/w"]],
  ]) {
    const s = setUp({ folders, roots });
    await s.runner.pass();
    assert.equal(s.runs.length, 0, JSON.stringify(folders));
    assert.match(s.problems(), /project p1 has 2 code-provider call\(s\) queued, and no watched, granted folder here/);
  }
  const s = setUp();
  await s.runner.pass();
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].cwd, "C:/w/p1");
  assert.equal(s.runs[0].script, join(CHECKOUT, SCRIPT));
  assert.equal(s.runs[0].nodePath, "C:/node/node.exe");
  assert.deepEqual(s.runner.state().problems, []);
});

test("the grant is read again before each client starts", async () => {
  // The bug: the grant read once per pass. A pass runs clients one after another for minutes, and a grant the
  // operator narrowed during the first must hold for the second.
  const s = setUp({
    pending: [{ projectId: "p1", queued: 1 }, { projectId: "p2", queued: 1 }],
    folders: [{ projectId: "p1", path: "C:/w/p1", platform: "win32" }, { projectId: "p2", path: "C:/w/p2", platform: "win32" }],
    exits: [{ during: (state) => { state.roots = []; } }],
  });
  await s.runner.pass();
  assert.deepEqual(s.runs.map((run) => run.cwd), ["C:/w/p1"]);
  assert.match(s.problems(), /project p2 has 1 code-provider call\(s\) queued, and no watched, granted folder/);
});

test("a folder is judged by its own platform's rule", async () => {
  // The bug: every folder compared as a Windows path, so a Linux host's /srv/x/p is never inside /srv/x and nothing
  // there is ever served.
  const s = setUp({ folders: [{ projectId: "p1", path: "/srv/x/p", platform: "linux" }], roots: ["/srv/x"] });
  await s.runner.pass();
  assert.deepEqual(s.runs.map((run) => run.cwd), ["/srv/x/p"]);
});

test("the client is handed its configuration, and nothing else from aify-env's environment", async () => {
  // The bug: the client inherits the daemon's environment, which can carry other services' keys.
  const s = setUp();
  await s.runner.pass();
  const env = s.runs[0].env;
  assert.deepEqual(Object.keys(env).sort(), [
    "APG_DASHBOARD_HOST", "APG_DASHBOARD_KEY", "APG_DASHBOARD_PROJECT", "APG_DASHBOARD_REPORTER", "APG_DASHBOARD_URL",
    "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "PATH", "SystemRoot",
  ]);
  assert.deepEqual(
    [env.APG_DASHBOARD_URL, env.APG_DASHBOARD_KEY, env.APG_DASHBOARD_PROJECT, env.APG_DASHBOARD_HOST, env.APG_DASHBOARD_REPORTER],
    ["http://127.0.0.1:9", KEY, "p1", "h", "aify-env:win32:h:r"],
  );
  assert.ok(!JSON.stringify(env).includes("s3cret") && !JSON.stringify(env).includes("comms-key"));
  // Windows answers PATH and Path alike; the child gets one of them, not two that Windows treats as one.
  assert.deepEqual(Object.keys(childEnv({ PATH: "a", Path: "a", SystemRoot: "r", SYSTEMROOT: "r" }, {})).sort(),
    ["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "PATH", "SystemRoot"]);
});

test("exit codes mean what was agreed: 0 and 3 run again, 2 and anything else stop the project", () => {
  // The bug: an exit the client does not use, or death by a signal, read as success or as "try again".
  const rows = [
    [{ code: 0 }, "ok"], [{ code: 3 }, "retry"], [{ code: 2 }, "configuration"], [{ code: 1 }, "bug"],
    [{ code: 4 }, "bug"], [{ code: 255 }, "bug"], [{ code: null, signal: "SIGKILL" }, "bug"], [{ code: null, timedOut: true }, "retry"],
  ];
  for (const [result, outcome] of rows) assert.equal(outcomeOf({ timedOut: false, ...result }), outcome, JSON.stringify(result));
});

test("a project stopped by exit 2 or a bug stays stopped until its configuration section changes", async () => {
  // The bugs: a client that exits 2 (its configuration is wrong) started again every minute for ever, or a stop
  // that nothing the operator does can lift short of a restart.
  const s = setUp({ exits: [{ code: 2, error: "APG_DASHBOARD_PROJECT is not a project" }] });
  await s.runner.pass();
  assert.match(s.problems(), /project p1: the provider client stopped with exit 2 \(its configuration\).*\(APG_DASHBOARD_PROJECT is not a project\)/);
  await s.runner.pass();
  assert.equal(s.runs.length, 1, "not started again under the same configuration");
  assert.match(s.problems(), /exit 2 \(its configuration\)/, "and still says why");
  assert.deepEqual(s.runner.state().stopped, ["p1"]);
  s.config = { providerCheckout: CHECKOUT, edited: true };
  await s.runner.pass();
  assert.equal(s.runs.length, 2, "an edited section lifts the stop");
  assert.deepEqual(s.runner.state().problems, []);

  for (const [exit, said] of [
    [{ code: 1 }, /exit 1 \(a bug\)/], [{ code: 7 }, /exit 7 \(a bug\)/], [{ code: null, signal: "SIGKILL" }, /exit SIGKILL \(a bug\)/],
    [{ code: null, error: "could not start it: spawn C:/node/node.exe ENOENT" }, /stopped with no exit: it could not be started; .*\(could not start it: spawn/],
  ]) {
    const b = setUp({ exits: [exit] });
    await b.runner.pass();
    await b.runner.pass();
    assert.equal(b.runs.length, 1, JSON.stringify(exit));
    assert.match(b.problems(), said);
  }
  const r = setUp({ exits: [{ code: 3 }] });
  await r.runner.pass();
  await r.runner.pass();
  assert.equal(r.runs.length, 2, "3 runs again");
  assert.deepEqual(r.runner.state().problems, []);
});

test("a run past its time counts as a retry, and says so once it repeats", async () => {
  // The bugs: a hung client latched like a bug, or killed every minute with nothing shown.
  const s = setUp({ exits: [{ code: null, timedOut: true }, { code: null, timedOut: true }, {}, { code: null, timedOut: true }] });
  await s.runner.pass();
  assert.deepEqual(s.runner.state().problems, [], "once is not yet a pattern");
  await s.runner.pass();
  assert.match(s.problems(), /project p1: the provider client ran past its time 2 times in a row and was stopped/);
  await s.runner.pass();
  assert.equal(s.runs.length, 3, "and it is still run");
  assert.deepEqual(s.runner.state().problems, [], "a run that ends clears it");
  await s.runner.pass();
  assert.deepEqual(s.runner.state().problems, [], "and the count starts again after it");
});

test("the dashboard key never reaches a doctor row", async () => {
  // The bug: the client's last stderr line is shown on /health as it was written, key and all.
  const s = setUp({ exits: [{ code: 1, error: `POST refused for x-api-key ${KEY}` }] });
  await s.runner.pass();
  assert.ok(!s.problems().includes(KEY));
  assert.match(s.problems(), /POST refused for x-api-key <the dashboard key>/);
});

test("an answer about queued calls in the wrong shape is a failure, never \"nothing queued\"", async () => {
  // The bug: a malformed answer read as an empty list, so queued calls wait for ever and the host looks idle.
  for (const answer of [
    null, { hostKey: "other", projects: [] }, { hostKey: "h", projects: "p1" },
    { hostKey: "h", projects: [{ projectId: "p1", queued: 0 }] }, { hostKey: "h", projects: [{ projectId: 5, queued: 1 }] },
    { hostKey: "h", projects: [{ projectId: "p1", queued: 1.5 }] },
  ]) {
    const s = setUp({ answer });
    await s.runner.pass();
    assert.equal(s.runs.length, 0, JSON.stringify(answer));
    assert.match(s.problems(), /the dashboard's answer about queued provider calls was not the shape it should be/, JSON.stringify(answer));
  }
});

test("with no credential the client is not started, and the row says so", async () => {
  const s = setUp({ key: "" });
  await s.runner.pass();
  assert.equal(s.runs.length, 0);
  assert.match(s.problems(), /project p1: no credential for aify-dashboard on this host/);
});

test("a stop during a run records nothing", async () => {
  // The bug: the kill a stop causes read as the client's exit, so a stopping plugin latches its projects.
  const s = setUp({ exits: [{ code: null, signal: "SIGKILL", stopped: true }] });
  await s.runner.pass();
  assert.deepEqual(s.runner.state(), { runs: 0, stopped: [], problems: [] });
});

test("through the plugin: a folder whose repository is outside the grant is never served", { skip: process.platform !== "win32" && "junctions are Windows-only" }, async (t) => {
  // The bug: the provider took the head watcher's folders as listed, so a junction the watcher refuses as leading
  // outside the grant still had the provider's client started in it, reading the repository outside.
  const { execFileSync } = await import("node:child_process");
  const { symlinkSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-provider-escape-")));
  const grant = join(root, "grant");
  const outside = join(root, "outside");
  mkdirSync(grant);
  mkdirSync(outside);
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "init", "-q"], { cwd: outside });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "outside"], { cwd: outside });
  symlinkSync(outside, join(grant, "junction"), "junction");
  const checkout = join(root, "apg");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, SCRIPT), "process.exit(0);\n");
  const listed = join(grant, "junction").replace(/\\/g, "/");
  const endpoint = "http://127.0.0.1:9";
  const fetch = async (url) => {
    const at = String(url);
    if (at.endsWith("/host/h/watch-list")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: listed } }] });
    if (at.endsWith("/host/h/provider/pending")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", queued: 1 }] });
    if (at.endsWith("/reports/head")) return Response.json({ ok: true, ackedHead: "", cursorRevision: 1 });
    return Response.json({ error: "not here", code: "no_route" }, { status: 404 });
  };
  const runs = [];
  const plugin = createDashboardPlugin({
    name: "aify-dashboard", endpoint, service: { name: "aify-dashboard", endpoint }, machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [grant] }), "win32"), [], "win32"),
    config: () => ({ config: { providerCheckout: checkout }, problem: "" }),
  }, { fetch, runChild: async (args) => { runs.push(args); return { code: 0, signal: null, timedOut: false, stopped: false, error: "" }; }, runEveryMs: 25, tickMs: 60_000 });
  t.after(() => plugin.stop());
  await plugin.start({ credential: async () => KEY });
  // Until both rows are up, or a run gives the defect away: the watcher's look and the provider's pass race.
  const rows = () => plugin.state().problems.join("\n");
  const settled = () => runs.length > 0 || (/no watched, granted folder/.test(rows()) && /this folder is not read/.test(rows()));
  for (let i = 0; i < 300 && !settled(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await plugin.stop();
  assert.deepEqual(runs, [], "the client was never started in it");
  assert.match(plugin.state().problems.join("\n"), /this folder is not read: its working tree is .*outside, outside every granted root/);
  assert.match(plugin.state().problems.join("\n"), /project p1 has 1 code-provider call\(s\) queued, and no watched, granted folder here/);
});

test("a folder served while inside the grant stops being offered once a look finds it outside", { skip: process.platform !== "win32" && "junctions are Windows-only" }, async () => {
  // The bug: the mark set once and never cleared, so a folder whose junction now leads outside is still handed to
  // the provider, from the last look that judged it inside.
  const { execFileSync } = await import("node:child_process");
  const { rmdirSync, symlinkSync } = await import("node:fs");
  const { GitReader } = await import("../lib/plugins/aify-dashboard/git-reader.mjs");
  const { HeadWatcher } = await import("../lib/plugins/aify-dashboard/head-watcher.mjs");
  const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-provider-moved-")));
  const grant = join(root, "grant");
  for (const dir of [join(grant, "inner"), join(root, "outside")]) {
    mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    gitIn(dir, "commit", "-q", "--allow-empty", "-m", dir);
  }
  const hop = join(grant, "hop");
  symlinkSync(join(grant, "inner"), hop, "junction");
  const listed = hop.replace(/\\/g, "/");
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: listed } }] }),
      reportHead: async ({ head }) => ({ ok: true, ackedHead: head, cursorRevision: 1 }),
    },
    git: new GitReader(),
    machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [grant] }), "win32"), [], "win32"),
    reporter: "r",
  });
  assert.deepEqual(watcher.watched(), [], "not offered before any look has judged it");
  await watcher.tick();
  assert.deepEqual(watcher.watched().map((f) => f.path), [listed], "offered while inside");
  rmdirSync(hop);
  symlinkSync(join(root, "outside"), hop, "junction");
  await watcher.tick();
  assert.deepEqual(watcher.watched(), [], "no longer offered once outside");
});

test("a folder whose git directory holds a way out is never offered, though its places are all inside", { skip: process.platform !== "win32" && "junctions are Windows-only" }, async () => {
  // The bug: the folder marked as servable once the places git resolves were judged, before what the git directory
  // holds was. Its working tree and git directories are inside the grant; only its objects lead out.
  const { execFileSync } = await import("node:child_process");
  const { rmSync, symlinkSync } = await import("node:fs");
  const { GitReader } = await import("../lib/plugins/aify-dashboard/git-reader.mjs");
  const { HeadWatcher } = await import("../lib/plugins/aify-dashboard/head-watcher.mjs");
  const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-provider-nested-")));
  const grant = join(root, "grant");
  const folder = join(grant, "folder");
  for (const dir of [folder, join(root, "outside")]) {
    mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    gitIn(dir, "commit", "-q", "--allow-empty", "-m", dir);
  }
  rmSync(join(folder, ".git", "objects"), { recursive: true, force: true });
  symlinkSync(join(root, "outside", ".git", "objects"), join(folder, ".git", "objects"), "junction");
  const listed = folder.replace(/\\/g, "/");
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: listed } }] }),
      reportHead: async ({ head }) => ({ ok: true, ackedHead: head, cursorRevision: 1 }),
    },
    git: new GitReader(),
    machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [grant] }), "win32"), [], "win32"),
    reporter: "r",
  });
  await watcher.tick();
  assert.match(watcher.state().problems.join("\n"), /its git directory holds a link at .*folder.\.git.objects/);
  assert.deepEqual(watcher.watched(), [], "never offered to the provider");
  await watcher.tick();
  assert.deepEqual(watcher.watched(), [], "nor on the next look");
});

test("through the plugin: it serves the watched folder once a minute, and stop ends the loop", async (t) => {
  // The bugs: the runner never wired into the plugin, wired to another endpoint or host, or a timer left after stop.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aify-dash-provider-")));
  const checkout = join(root, "apg");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, SCRIPT), "process.exit(0);\n");
  const proj = join(root, "proj").replace(/\\/g, "/");
  mkdirSync(proj);
  // A real repository: a folder is served only once a look has judged where git reads it from.
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "init", "-q"], { cwd: proj });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "p"], { cwd: proj });
  const endpoint = "http://127.0.0.1:9";
  const fetch = async (url) => {
    const at = String(url);
    if (at.endsWith("/host/h/watch-list")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: proj } }] });
    if (at.endsWith("/host/h/provider/pending")) return Response.json({ hostKey: "h", projects: [{ projectId: "p1", queued: 1 }] });
    if (at.endsWith("/reports/head")) return Response.json({ ok: true, ackedHead: "", cursorRevision: 1 });
    return Response.json({ error: "not here", code: "no_route" }, { status: 404 });
  };
  const runs = [];
  const runChild = async (args) => { runs.push(args); return { code: 0, signal: null, timedOut: false, stopped: false, error: "" }; };
  const plugin = createDashboardPlugin({
    name: "aify-dashboard", endpoint, service: { name: "aify-dashboard", endpoint }, machineId: "win32:h",
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [root] }), "win32"), [], "win32"),
    config: () => ({ config: { providerCheckout: checkout }, problem: "" }),
  }, { fetch, runChild, runEveryMs: 25, tickMs: 60_000 });
  t.after(() => plugin.stop());
  await plugin.start({ credential: async () => KEY });
  for (let i = 0; i < 100 && runs.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await plugin.stop();
  assert.ok(runs.length >= 2, `ran ${runs.length} times`);
  assert.equal(runs[0].cwd, proj);
  assert.equal(runs[0].script, join(checkout, SCRIPT));
  assert.equal(runs[0].env.APG_DASHBOARD_URL, endpoint);
  assert.equal(runs[0].env.APG_DASHBOARD_HOST, "h");
  assert.equal(runs[0].env.APG_DASHBOARD_PROJECT, "p1");
  assert.match(runs[0].env.APG_DASHBOARD_REPORTER, /^aify-env:win32:h:[0-9a-f-]{36}$/);
  assert.equal(plugin.state().provider.runs, runs.length);
  const after = runs.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runs.length, after, "no pass after stop");
});
