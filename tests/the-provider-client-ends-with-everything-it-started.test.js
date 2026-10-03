// The code provider's client as a real process: what environment it sees, and that it ends with every process it
// started, whether it ran past its time or the plugin stopped. Each script here is written to a scratch folder and
// run by this node, as the plugin runs the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnv, killTree, runChild, taskkillPath } from "../lib/plugins/aify-dashboard/provider-child.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "aify-provider-child-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
async function until(check, ms = 10_000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/**
 * A client that starts a grandchild, records both pids, and then never exits by itself.
 *
 * The grandchild is DETACHED. On Windows a child node starts without it is held in node's own job object, and dies
 * with the child whatever kills the child (measured: a kill without taskkill's /T took it down too), so a test of that
 * kind cannot tell a tree kill from a plain one. A detached one leaves that job, and only a kill that walks the tree
 * reaches it.
 */
function hangingClient(dir) {
  const script = join(dir, "client.mjs");
  writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });',
    'writeFileSync(process.env.PIDS_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return script;
}

test("the client sees only the environment it was handed", async () => {
  // The bug: the child inherits the daemon's environment, which can carry other services' keys. The same probe is
  // run once with the sentinel handed over on purpose, so a probe that could never see it cannot pass.
  const dir = scratch();
  const script = join(dir, "env.mjs");
  writeFileSync(script, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUT_FILE, JSON.stringify(process.env));\n');
  const parent = { ...process.env, AIFY_TEST_SENTINEL: "sentinel-9d41" };
  const seen = async (configuration) => {
    const out = join(dir, `env-${Object.keys(configuration).length}.json`);
    const result = await runChild({ nodePath: process.execPath, script, cwd: dir, env: childEnv(parent, { OUT_FILE: out, ...configuration }) });
    assert.equal(result.code, 0, result.error);
    return readFileSync(out, "utf8");
  };
  const handed = await seen({ APG_DASHBOARD_PROJECT: "p1" });
  assert.ok(!handed.includes("sentinel-9d41"), "the parent's sentinel did not reach the child");
  assert.match(handed, /"APG_DASHBOARD_PROJECT":"p1"/);
  assert.match(await seen({ APG_DASHBOARD_PROJECT: "p1", PASSED_ON_PURPOSE: "sentinel-9d41" }), /sentinel-9d41/, "positive control: the probe can see it");
});

test("a client past its time is killed with everything it started", { timeout: 30_000 }, async (t) => {
  // The bug: only the node process killed, leaving the git (here, a grandchild) it started running for ever.
  const dir = scratch();
  const pidsFile = join(dir, "pids.json");
  const running = runChild({ nodePath: process.execPath, script: hangingClient(dir), cwd: dir, env: childEnv(process.env, { PIDS_FILE: pidsFile }), timeoutMs: 3_000 });
  assert.ok(await until(() => existsSync(pidsFile)), "the client started its grandchild");
  const pids = JSON.parse(readFileSync(pidsFile, "utf8"));
  // A grandchild a failing run leaves behind is ended here, not left running on the host.
  t.after(() => { try { process.kill(pids.grandchild); } catch { /* already gone */ } });
  assert.ok(alive(pids.grandchild), "positive control: the grandchild was running");
  const result = await running;
  assert.equal(result.timedOut, true);
  assert.ok(await until(() => !alive(pids.grandchild)), "the grandchild is gone");
  assert.ok(!alive(pids.child));
});

test("a stop kills the client and everything it started, and is not read as its exit", { timeout: 30_000 }, async (t) => {
  const dir = scratch();
  const pidsFile = join(dir, "pids.json");
  const stop = new AbortController();
  const running = runChild({ nodePath: process.execPath, script: hangingClient(dir), cwd: dir, env: childEnv(process.env, { PIDS_FILE: pidsFile }), signal: stop.signal });
  assert.ok(await until(() => existsSync(pidsFile)));
  const pids = JSON.parse(readFileSync(pidsFile, "utf8"));
  // A grandchild a failing run leaves behind is ended here, not left running on the host.
  t.after(() => { try { process.kill(pids.grandchild); } catch { /* already gone */ } });
  assert.ok(alive(pids.grandchild));
  stop.abort();
  const result = await running;
  assert.equal(result.stopped, true);
  assert.equal(result.timedOut, false);
  assert.ok(await until(() => !alive(pids.grandchild)), "the grandchild is gone");
});

test("a client that cannot be started ends the run with the reason, never hangs it", { timeout: 30_000 }, async () => {
  // The bug: a spawn that fails leaves the run waiting for a close that never comes, and every later pass behind it.
  const dir = scratch();
  const result = await Promise.race([
    runChild({ nodePath: join(dir, "no-such-node.exe"), script: join(dir, "x.mjs"), cwd: dir, env: childEnv(process.env, {}) }),
    sleep(10_000).then(() => "hung"),
  ]);
  assert.notEqual(result, "hung");
  assert.equal(result.code, null);
  assert.match(result.error, /ENOENT/);
});

test("taskkill is run by its absolute path, never by name", async () => {
  // The bug: a bare "taskkill" is looked up in the working directory before PATH on Windows, the way a planted
  // git.exe once ran inside this daemon.
  assert.equal(taskkillPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\taskkill.exe");
  assert.equal(taskkillPath({}), null);
  assert.equal(taskkillPath({ SystemRoot: "Windows" }), null, "a relative root is no root");
  const ran = [];
  await killTree(4242, { platform: "win32", taskkill: taskkillPath({ SystemRoot: "C:\\Windows" }), run: (file, args, options, done) => { ran.push([file, ...args]); done(); } });
  assert.deepEqual(ran, [["C:\\Windows\\System32\\taskkill.exe", "/T", "/F", "/PID", "4242"]]);
  ran.length = 0;
  await killTree(2 ** 30, { platform: "win32", taskkill: null, run: (file) => { ran.push(file); } });
  assert.deepEqual(ran, [], "with no SystemRoot nothing is run by name");
});
