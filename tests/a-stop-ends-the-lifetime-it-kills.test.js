// A stop of a live managed child resolves only once the child's exit is observed, so the lifetime it ended is proven
// ended when the shutdown asks. Before this, `Runner.stop` returned as soon as killTree did, and a daemon stopped with
// a live worker logged `agent state retirement: not-proven` and never retired its key (aify-comms
// docs/evidence/2026-10-21-worker-retire). The wait is bounded: a child whose exit never comes still lets stop return,
// and its lifetime stays unproven.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { Runner } from "../lib/runner.mjs";
import { buildStartSpec } from "../lib/start-spec.mjs";

const AT = 1_790_950_000_600_000;
const TEXT = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\n';

/** A runner whose one child is alive until killed; `exitAfterKillMs` null means the exit is never observed. */
function fixture(t, { exitAfterKillMs, stopExitWaitMs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-ends-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = new AgentStateHost({ aifyHome: dir, instance: "default", population: "managed", nowUs: () => AT + 1000,
    probe: (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: AT - 10, commandLine: "bash /fixture/claude-aify" }])) });
  host.boot();
  let child = null;
  const spawn = (_command, _args, options) => {
    child = new EventEmitter();
    Object.assign(child, { pid: 100, cols: 80, rows: 24, env: options.env, stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { write() {} }, onData() {}, onExit(fn) { child.finish = fn; }, destroy() {}, write() {}, resize() {},
      kill() { if (exitAfterKillMs !== null) setTimeout(() => child.finish({ exitCode: null, signal: "SIGTERM" }), exitAfterKillMs); } });
    return child;
  };
  const runner = new Runner({ openTerminal: spawn, spawnProcess: spawn, stopExitWaitMs,
    managedHost: () => ({ host, instance: "default", url: "http://127.0.0.1:18802" }), reportManaged: () => {},
    isAlive: () => true, killTree: async () => {} });
  const spec = buildStartSpec({ service: "fixture", launcher: "/fixture/claude-aify", agentId: "lead", env: { PATH: "toolchain" } },
    { readFile: () => TEXT, platform: "linux" }).spec;
  return { host, runner, start: async () => ({ handle: await runner.start(spec), lifetime: child.env.AIFY_LIFETIME }) };
}

test("a stop whose kill ends the child has ended its lifetime by the time it resolves", async (t) => {
  const f = fixture(t, { exitAfterKillMs: 50, stopExitWaitMs: 2000 });
  const { handle, lifetime } = await f.start();
  assert.equal(f.host.retirementProof([lifetime]).holds, false, "CONTROL: a live lifetime is not proven ended");
  await f.runner.stop(handle.id);
  assert.equal(f.host.retirementProof([lifetime]).holds, true, "the stop resolved before the exit it caused was observed");
});

test("a stop whose child never exits still returns at the bound, and the lifetime stays unproven", async (t) => {
  const f = fixture(t, { exitAfterKillMs: null, stopExitWaitMs: 100 });
  const { handle, lifetime } = await f.start();
  const from = Date.now();
  await f.runner.stop(handle.id);
  assert.ok(Date.now() - from < 1500, "the stop waited past its bound");
  assert.equal(f.host.retirementProof([lifetime]).holds, false, "an exit never observed was taken as an end");
});

test("the wait is announced as its own phase, after the tree-kill and before done", async (t) => {
  const f = fixture(t, { exitAfterKillMs: 20, stopExitWaitMs: 2000 });
  const { handle } = await f.start();
  const phases = [];
  await f.runner.stop(handle.id, { phase: (name) => phases.push(name) });
  assert.deepEqual(phases, ["console-kill", "tree-kill", "exit-wait", "done"]);
});
