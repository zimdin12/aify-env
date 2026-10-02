// The aify-dashboard plugin as the host sees it: built from the factory map, declining on a dedicated
// instance, failing closed without a grant, stopping cleanly. And the two doctor rows it touches: the
// claiming row must not count it, and the plugin-problems row must repeat what it says.

import { test } from "node:test";
import assert from "node:assert/strict";

import { claimingCheck } from "../lib/environment-checks.mjs";
import { STATE } from "../lib/health.mjs";
import { pluginProblemsCheck } from "../lib/plugin-problems-check.mjs";
import { DEDICATED_DECLINE, createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { LIST_EVERY_MS } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { pluginsForServices, servicesWithPlugins } from "../lib/plugins/index.mjs";

const entry = { name: "aify-dashboard", endpoint: "http://127.0.0.1:9" };
const host = { credential: async () => "a-key" };

/** A fetch that records, and answers an empty watch list for whichever host asked. */
function recordingFetch() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hostKey = decodeURIComponent(String(url).split("/host/")[1]?.split("/")[0] ?? "");
    return new Response(JSON.stringify({ hostKey, projects: [] }), { status: 200 });
  };
  return { fetch, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the factory map builds it for an aify-dashboard entry", () => {
  assert.ok(servicesWithPlugins().includes("aify-dashboard"));
  const { plugins, unserved } = pluginsForServices([entry], { machineId: "win32:h" });
  assert.deepEqual(unserved, []);
  assert.equal(plugins[0].name, "aify-dashboard");
  assert.equal(plugins[0].endpoint, entry.endpoint);
});

test("on a herdr's dedicated instance it starts nothing and says why", async () => {
  // The bug: two daemons on one host both reporting a folder, each undoing the other's head.
  const recorded = recordingFetch();
  const plugin = createDashboardPlugin({ ...entry, service: entry, machineId: "win32:h", dedicated: true }, { fetch: recorded.fetch });
  await plugin.start(host);
  await settle();
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(plugin.state(), { phase: "declined", declined: DEDICATED_DECLINE, problems: [] });
  await plugin.stop();
});

test("an aify-env that offers no watchRoots grants nothing, and the state says so", async () => {
  const recorded = recordingFetch();
  const plugin = createDashboardPlugin({ ...entry, service: entry, machineId: "win32:h" }, { fetch: recorded.fetch });
  await plugin.start(host);
  await settle();
  await plugin.stop();
  assert.equal(recorded.calls.length, 1, "the list is still fetched");
  assert.match(plugin.state().problems.join("\n"), /offers no watchRoots setting/);
  assert.equal(plugin.state().phase, "stopped");
});

test("a grant in any other shape than {roots, problems} reads nothing, and says so", async () => {
  // The bug: the grant's shape moved once (a single `problem` became a `problems` list), and taking the
  // roots while reading the old field dropped every reason in silence.
  for (const grant of [{ roots: ["c:/"], problem: "" }, { roots: "c:/", problems: [] }, null]) {
    const recorded = recordingFetch();
    const plugin = createDashboardPlugin({ ...entry, service: entry, machineId: "win32:h", watchRoots: async () => grant }, { fetch: recorded.fetch });
    await plugin.start(host);
    await settle();
    await plugin.stop();
    assert.match(plugin.state().problems.join("\n"), /not \{roots, problems\} lists, so no folder is read/, JSON.stringify(grant));
  }
});

test("stop does not wait out a git process or a request: both are cancelled", async () => {
  // The bug: stop awaited the whole tick, and a tick can wait on git (30 s each) and on HTTP (10 s each) folder after
  // folder. The host stops plugins in reverse start order inside a shared budget, so a slow stop here used up the
  // other plugins' chance to stop. Each case below hangs until it is cancelled, and stop is given one second.
  const { GitReader } = await import("../lib/plugins/aify-dashboard/git-reader.mjs");
  const listed = { hostKey: "h", projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: "C:/w/proj" } }] };
  const hangUntilAborted = (signal, onAbort) => new Promise((resolve, reject) => {
    signal?.addEventListener("abort", () => { onAbort?.(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  });
  const cases = {
    "a git process": {
      execFile: (file, args, options, callback) => { hangUntilAborted(options.signal).catch((error) => callback(Object.assign(error, { code: "ABORT_ERR" }), "", "")); },
      fetch: async () => new Response(JSON.stringify(listed), { status: 200 }),
    },
    "a request": {
      execFile: (file, args, options, callback) => callback(null, "C:/git/x\nC:/git/x\n", ""),
      fetch: async (url, options) => hangUntilAborted(options.signal),
    },
  };
  for (const [name, { execFile, fetch }] of Object.entries(cases)) {
    let started = false;
    const plugin = createDashboardPlugin(
      { ...entry, service: entry, machineId: "win32:h", watchRoots: async () => ({ roots: ["c:/w"], problems: [] }) },
      { fetch: async (...args) => { started = true; return fetch(...args); },
        git: new GitReader({ execFile: (...args) => { started = true; return execFile(...args); } }) },
    );
    await plugin.start(host);
    for (let waited = 0; !started; waited += 1) {
      assert.ok(waited < 500, `${name}: nothing started`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outcome = await Promise.race([plugin.stop().then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1000))]);
    assert.equal(outcome, "stopped", `${name}: stop returned within a second`);
    assert.equal(plugin.state().phase, "stopped");
    // The cancellation is the stop, not a fault in the folder or the list: a doctor row after a clean shutdown
    // would send somebody looking for a problem that is not there.
    assert.deepEqual(plugin.state().problems, [], `${name}: the cancelled work recorded no problem`);
  }
});

test("a stop that arrives during a tick ends the loop, and detach always detaches", async () => {
  // The bug: the tick that was running when stop arrived schedules the next one anyway, so a detached
  // plugin keeps calling the dashboard. The clock jumps a refresh interval per read, so every tick
  // fetches and a tick that ran would be seen; the second fetch is held open until stop has been asked.
  const recorded = recordingFetch();
  let release = null;
  const fetch = async (url) => {
    if (recorded.calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return recorded.fetch(url);
  };
  let clock = 0;
  const plugin = createDashboardPlugin(
    { ...entry, service: entry, machineId: "win32:h", watchRoots: async () => ({ roots: [], problems: ["none"] }) },
    { fetch, tickMs: 5, now: () => (clock += LIST_EVERY_MS) },
  );
  await plugin.start(host);
  for (let waited = 0; release === null; waited += 1) {
    assert.ok(waited < 500, "the second tick never started");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(plugin.state().phase, "running");
  const detaching = plugin.detach();
  release();
  assert.deepEqual(await detaching, { detached: true, held: 0 });
  await settle();
  assert.equal(recorded.calls.length, 2, "the tick in flight finished, and none followed it");
});

test("the claiming row ignores a plugin that claims nothing", () => {
  // The bug: a folder watcher counted as a claimer that has not answered, which turns the row amber on
  // every host that loads it, or hides the fact that nothing here claims at all.
  const watcherOnly = [{ name: "aify-dashboard", state: { phase: "running", problems: [] } }];
  const alone = claimingCheck({ answered: true, plugins: watcherOnly });
  assert.equal(alone.state, STATE.FAILED);
  assert.match(alone.detail, /nothing here claims work/);

  const beside = claimingCheck({
    answered: true,
    plugins: [{ name: "aify-comms", state: { claimer: { accepted: true } } }, ...watcherOnly],
  });
  assert.equal(beside.state, STATE.PASSED);
  assert.equal(beside.detail, "claiming work for: aify-comms");
});

test("the plugin-problems row repeats each plugin's problems under its name, and passes only on a report", () => {
  const failing = pluginProblemsCheck({ answered: true, plugins: [
    { name: "aify-comms", state: { claimer: null } },
    { name: "aify-dashboard", state: { problems: ["C:/x is not read: no folder is granted"] } },
  ] });
  assert.equal(failing.state, STATE.FAILED);
  assert.equal(failing.detail, "aify-dashboard: C:/x is not read: no folder is granted");

  const clean = pluginProblemsCheck({ answered: true, plugins: [{ name: "aify-dashboard", state: { problems: [] } }] });
  assert.equal(clean.state, STATE.PASSED);

  // No plugin that reports problems is no row at all: not a pass on no evidence, and not a standing amber.
  assert.equal(pluginProblemsCheck({ answered: true, plugins: [{ name: "aify-comms", state: {} }] }), null);
  assert.equal(pluginProblemsCheck({ answered: false }).state, STATE.UNANSWERED);
});
