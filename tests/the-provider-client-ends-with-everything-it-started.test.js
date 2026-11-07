// The code provider's client as a real process: what environment it sees, and that it ends with every process it
// started, whether it ran past its time or the plugin stopped. Each script here is written to a scratch folder and
// run by this node, as the plugin runs the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { childEnv, killTree, runChild } from "../lib/plugins/aify-dashboard/provider-child.mjs";
import { KnownWindowsTree } from "./test-data/owned-windows-tree.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "aify-provider-child-"));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const fixtureInputs = client => Object.fromEntries([client.script, client.grandchildScript].map(file => [basename(file), {
  present: existsSync(file), sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), body: readFileSync(file, 'utf8'),
}]));
function retainNativeProof(mode, client, tree, result) {
  const after = fixtureInputs(client), evidence = process.env.AIFY_TEST_EVIDENCE_DIR;
  if (evidence) {
    const target = resolve(evidence), owned = resolve(ROOT, '.check-output');
    assert.ok(target.startsWith(owned + sep), 'native evidence belongs to this checkout output');
    mkdirSync(target, { recursive: true });
    const file = join(target, `provider-${mode}.json`); assert.equal(existsSync(file), false, 'use a fresh native round');
    writeFileSync(file, JSON.stringify({ platform: process.platform, node: process.version, root: tree.root, grandchild: tree.grandchild,
      result, recordOnly: tree.recordOnly, helpers: tree.helperInputs, inputs: { before: client.inputs, after } }, null, 2));
  }
  assert.deepEqual(after, client.inputs, 'generated client inputs are unchanged');
  for (const helper of tree.helperInputs) assert.deepEqual(helper.after, helper.before, 'actual helper source inputs are unchanged');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
/**
 * A kill that only records what it was asked to kill. A probe whose subject is not the kill takes this, so its own
 * timer firing could never reach a real taskkill (comms-senior-dev, safety addendum on cc3999c).
 */
function recordingKill() {
  const asked = [];
  return { asked, kill: async (pid) => { asked.push(pid); } };
}

async function until(check, ms = 10_000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/** How long the fixture's root and grandchild live at most, by themselves. Past every kill and wait in these tests. */
const SELF_EXIT_MS = 20_000;

/**
 * A client that starts a grandchild, records both pids, and then never exits by itself before SELF_EXIT_MS.
 *
 * On Windows the grandchild is DETACHED. A child node starts without it is held in node's own job object, and dies
 * with the child whatever kills the child (measured: a kill without taskkill's /T took it down too), so a test of that
 * kind cannot tell a tree kill from a plain one. A detached one leaves that job, and only a kill that walks the tree
 * reaches it. Elsewhere it is NOT detached: it stays in the root's process group, which runChild created and the core
 * ends as one group.
 *
 * ⛔ Nothing here kills a fixture process by pid. A cleanup that killed `pids.grandchild` ran after the test had
 * confirmed that pid gone, when Windows may already have given it to any process on this host (comms-tech-lead, on
 * cc3999c: a file of this suite died with exit 1 and nothing said, which is how such a kill ends a process). Instead
 * both processes end themselves: at once when the test writes `done` (its cleanup, `finish()`), or at SELF_EXIT_MS,
 * when each first writes its own `expired` marker. A process the kill ended can write no marker, so the tests assert
 * none was written: a self-exit can never pass for the kill.
 */
function hangingClient(dir) {
  const paths = {
    script: join(dir, "client.mjs"),
    grandchildScript: join(dir, "grandchild.mjs"),
    pidsFile: join(dir, "pids.json"),
    done: join(dir, "done"),
    rootExpired: join(dir, "root-expired"),
    grandchildExpired: join(dir, "grandchild-expired"),
  };
  const exitWhenDone = (marker) => [
    `setInterval(() => { if (existsSync(${JSON.stringify(paths.done)})) process.exit(0); }, 50);`,
    `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, "expired"); process.exit(91); }, ${SELF_EXIT_MS});`,
  ];
  writeFileSync(paths.grandchildScript, [
    'import { existsSync, writeFileSync } from "node:fs";',
    ...exitWhenDone(paths.grandchildExpired),
    "",
  ].join("\n"));
  writeFileSync(paths.script, [
    'import { spawn } from "node:child_process";',
    'import { existsSync, renameSync, writeFileSync } from "node:fs";',
    `const grandchild = spawn(process.execPath, [${JSON.stringify(paths.grandchildScript)}], { stdio: "ignore", windowsHide: true, detached: process.platform === "win32" });`,
    // Written whole or not at all, so the test never reads half a file.
    `grandchild.once("spawn", () => { writeFileSync(${JSON.stringify(`${paths.pidsFile}.tmp`)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid })); renameSync(${JSON.stringify(`${paths.pidsFile}.tmp`)}, ${JSON.stringify(paths.pidsFile)}); });`,
    ...exitWhenDone(paths.rootExpired),
    "",
  ].join("\n"));
  return { ...paths, inputs: fixtureInputs(paths), finish: () => writeFileSync(paths.done, "done") };
}

/**
 * runChild's ports for a fixture tree: the real spawn, its ChildProcess adopted as the known root, and the core
 * endOwnedChildTree (`killTree`) with its held port restricted to that tree on Windows (test-data/owned-windows-tree.mjs
 * says why that injection is intentional). Elsewhere the core ends the owned POSIX group runChild made, as it would.
 */
function knownTreePorts(tree) {
  return {
    start: (...args) => tree.adopt(spawn(...args)),
    kill: (pid, options) => killTree(pid, { ...options, held: tree.held }),
  };
}

/** What the held port must have seen once the tree was killed: one call, for the started root, and only on Windows. */
function assertKilledThroughKnownRoot(tree) {
  if (process.platform === "win32") {
    assert.deepEqual(tree.heldCalls, [tree.root], "the held kill was asked for the started root, once");
    assert.equal(tree.helpersStarted, 1, "one helper, the core's, on the known tree");
  } else {
    assert.deepEqual(tree.heldCalls, [], "no held kill off Windows: the owned group is ended");
  }
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
    const kills = recordingKill();
    const result = await runChild({ nodePath: process.execPath, script, cwd: dir, env: childEnv(parent, { OUT_FILE: out, ...configuration }), kill: kills.kill });
    assert.equal(result.code, 0, result.error);
    assert.deepEqual(kills.asked, [], "a client that exits by itself is killed by nothing");
    return readFileSync(out, "utf8");
  };
  const handed = await seen({ APG_DASHBOARD_PROJECT: "p1" });
  assert.ok(!handed.includes("sentinel-9d41"), "the parent's sentinel did not reach the child");
  assert.match(handed, /"APG_DASHBOARD_PROJECT":"p1"/);
  assert.match(await seen({ APG_DASHBOARD_PROJECT: "p1", PASSED_ON_PURPOSE: "sentinel-9d41" }), /sentinel-9d41/, "positive control: the probe can see it");
});

test("a client past its time is killed with everything it started", { timeout: 30_000 }, async () => {
  // The bug: only the node process killed, leaving the git (here, a grandchild) it started running for ever.
  const dir = scratch();
  const client = hangingClient(dir);
  const tree = new KnownWindowsTree({ recordOnly: process.env.AIFY_TEST_KNOWN_TREE_RECORD_ONLY === '1' });
  try {
    const running = runChild({ nodePath: process.execPath, script: client.script, cwd: dir, env: childEnv(process.env, {}), timeoutMs: 3_000, ...knownTreePorts(tree) });
    assert.ok(await until(() => existsSync(client.pidsFile)), "the client started its grandchild");
    const pids = tree.learn(client.pidsFile);
    assert.equal(pids.child, tree.root, "the pids file is the started client's");
    assert.ok(alive(pids.grandchild), "positive control: the grandchild was running");
    const result = await running;
    retainNativeProof('timeout', client, tree, result);
    assert.equal(result.timedOut, true);
    assert.equal(result.unconfirmed, "", "the kill confirmed the tree ended");
    assertKilledThroughKnownRoot(tree);
    assert.ok(await until(() => !alive(pids.grandchild)), "the grandchild is gone");
    assert.ok(!alive(pids.child));
    assert.ok(!existsSync(client.grandchildExpired) && !existsSync(client.rootExpired), "ended by the kill, not by their own deadline");
  } finally {
    client.finish();
  }
});

test("a stop kills the client and everything it started, and is not read as its exit", { timeout: 30_000 }, async () => {
  const dir = scratch();
  const client = hangingClient(dir);
  const tree = new KnownWindowsTree({ recordOnly: process.env.AIFY_TEST_KNOWN_TREE_RECORD_ONLY === '1' });
  try {
    const stop = new AbortController();
    const running = runChild({ nodePath: process.execPath, script: client.script, cwd: dir, env: childEnv(process.env, {}), signal: stop.signal, ...knownTreePorts(tree) });
    assert.ok(await until(() => existsSync(client.pidsFile)));
    const pids = tree.learn(client.pidsFile);
    assert.equal(pids.child, tree.root, "the pids file is the started client's");
    assert.ok(alive(pids.grandchild));
    stop.abort();
    const result = await running;
    retainNativeProof('stop', client, tree, result);
    assert.equal(result.stopped, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.unconfirmed, "", "the kill confirmed the tree ended");
    assertKilledThroughKnownRoot(tree);
    assert.ok(await until(() => !alive(pids.grandchild)), "the grandchild is gone");
    assert.ok(!existsSync(client.grandchildExpired) && !existsSync(client.rootExpired), "ended by the kill, not by their own deadline");
  } finally {
    client.finish();
  }
});

test("a client that cannot be started ends the run with the reason, never hangs it", { timeout: 30_000 }, async () => {
  // The bug: a spawn that fails leaves the run waiting for a close that never comes, and every later pass behind it.
  const dir = scratch();
  const kills = recordingKill();
  const result = await Promise.race([
    runChild({ nodePath: join(dir, "no-such-node.exe"), script: join(dir, "x.mjs"), cwd: dir, env: childEnv(process.env, {}), kill: kills.kill }),
    sleep(10_000).then(() => "hung"),
  ]);
  assert.notEqual(result, "hung");
  assert.deepEqual(kills.asked, [], "a client that never started is killed by nothing");
  assert.equal(result.code, null);
  assert.match(result.error, /ENOENT/);
});
