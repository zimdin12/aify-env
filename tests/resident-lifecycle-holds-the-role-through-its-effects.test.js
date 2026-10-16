// B1 contract item 7, review J1: a resident's lifecycle request needs the residents role for EVERY effect it has, not
// only the kill. A cold resident (no running lifetime) never reaches the kill, yet its stop writes the operator-stop
// fact and its delete removes the definition; and after a live kill, the refresh can remove resident records. So a
// non-holder refuses both, and a role lost mid-operation stops every later effect. Each case has a holder control that
// completes. Real locks of temp homes, the real definition store and journal; only the OS probe and the kill are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { DaemonResidents } from "../lib/daemon-residents.mjs";

const SKIP = process.platform === "win32" || process.platform === "linux" ? false : `not qualified on ${process.platform}`;
const L1 = "7f3c9e2a-0000-4000-8000-0000000000e1";
const PID = 4243;
const WRITTEN = 1_790_950_000_000_000;

async function fixture(t, { record = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-res-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, ".aify");
  fs.mkdirSync(path.join(home, "env"), { recursive: true });
  fs.writeFileSync(path.join(home, "env", "residents.generation"), "400\n");
  fs.writeFileSync(path.join(home, "agent-lifecycle.json"), JSON.stringify({ version: 1, records: {}, stops: {} }));
  const recordFile = path.join(home, "residents", `lead.${L1}.json`);
  if (record) {
    fs.mkdirSync(path.dirname(recordFile));
    fs.writeFileSync(recordFile, JSON.stringify({ agentId: "lead", lifetime: L1, instance: "residents", harness: "claude",
      pid: PID, launcher: process.execPath, writtenAtUs: WRITTEN }));
  }
  let alive = true;
  const osProbe = (pids) => new Map(pids.map((pid) => [pid, pid === PID && alive
    ? { alive: true, createdAtUs: WRITTEN - 1, commandLine: `node "${process.execPath}"` }
    : { alive: false, createdAtUs: null, commandLine: null }]));
  const residents = (url) => {
    const owner = new DaemonResidents({ aifyHome: home, url, pid: process.pid, probe: osProbe, nowUs: () => WRITTEN + 1_000_000 });
    t.after(() => owner.release({ waitMs: 0 }));
    return owner;
  };
  const managed = new AgentStateHost({ aifyHome: home, instance: "default", probe: osProbe, nowUs: () => WRITTEN + 1_000_000,
    population: "managed" });
  managed.boot();
  const definitions = new DefinitionStore({ dir: path.join(home, "definitions") });
  await definitions.set("lead", { id: "lead", name: "Lead", role: "worker", harness: "claude", mode: "resident", workspace: home,
    model: "", effort: "", instructions: "", env: {}, herdrSpace: false }, { installed: new Set(["claude"]) });
  const kills = [];
  const ports = (owner, { onKill = async () => {}, onInstalled = async () => {} } = {}) => createAgentLifecyclePorts({
    aifyHome: home, machineId: "m", stateHost: managed, residents: owner, runner: {}, definitions, probe: async (pids) => osProbe(pids),
    installed: async () => { await onInstalled(); return new Set(["claude"]); }, settleMs: 1000,
    killTree: async (pid) => { kills.push(pid); alive = false; await onKill(); } });
  let n = 0;
  const request = async (action, expectedLifetime) => {
    const listed = await definitions.list();
    const row = listed.definitions.find((r) => r.id === "lead");
    return { id: `r${++n}`, agentId: "lead", machineId: "m", storeId: listed.storeId, expectedIncarnation: row.incarnation,
      expectedRevision: row.revision, expectedLifetime, action, requestedBy: "fixture" };
  };
  const defined = async () => (await definitions.list()).definitions.some((r) => r.id === "lead");
  const stopFact = (owner) => [...ports(owner).stopFacts().values()];
  return { home, recordFile, residents, ports, definitions, kills, request, defined, stopFact };
}
const outcome = (answer) => [answer.status, answer.outcome];

test("a cold resident's stop and delete need the role: a non-holder writes no stop fact and removes nothing", { skip: SKIP }, async (t) => {
  const f = await fixture(t);
  const holder = f.residents("http://127.0.0.1:1"), other = f.residents("http://127.0.0.1:2");
  assert.equal(await holder.acquire(), true);
  assert.equal(await other.acquire(), false);
  const theirs = f.ports(other).lifecycle;
  assert.deepEqual(outcome(await theirs.execute(await f.request("stop", null))), ["refused", "not-owner"]);
  assert.deepEqual(outcome(await theirs.execute(await f.request("delete", null))), ["refused", "not-owner"]);
  assert.deepEqual(f.stopFact(other), [], "a non-holder wrote the resident's operator-stop fact");
  assert.equal(await f.defined(), true, "a non-holder removed the resident's definition");
  const mine = f.ports(holder).lifecycle;
  assert.deepEqual(outcome(await mine.execute(await f.request("stop", null))), ["done", "stop"], "control: the holder stops it");
  assert.deepEqual(f.stopFact(holder), [true]);
  assert.deepEqual(outcome(await mine.execute(await f.request("delete", null))), ["done", "delete"], "control: the holder deletes it");
  assert.equal(await f.defined(), false);
});

test("a cold resident whose role is lost before the stop fact, or before the removal, gets neither", { skip: SKIP }, async (t) => {
  const f = await fixture(t);
  const holder = f.residents("http://127.0.0.1:1");
  assert.equal(await holder.acquire(), true);
  const real = f.definitions.withLifecycleDefinition.bind(f.definitions);
  f.definitions.withLifecycleDefinition = async (work) => { await holder.release({ waitMs: 0 }); return real(work); };
  assert.deepEqual(outcome(await f.ports(holder).lifecycle.execute(await f.request("stop", null))), ["refused", "not-owner"]);
  assert.deepEqual(f.stopFact(holder), [], "the stop fact was written after the role was lost");

  const g = await fixture(t);
  const second = g.residents("http://127.0.0.1:3");
  assert.equal(await second.acquire(), true);
  const losing = g.ports(second, { onInstalled: () => second.release({ waitMs: 0 }) }).lifecycle;
  assert.deepEqual(outcome(await losing.execute(await g.request("delete", null))),
    ["refused", "stopped; the definition was not removed: not-owner"]);
  assert.equal(await g.defined(), true, "the definition was removed after the role was lost");
  assert.deepEqual(g.stopFact(second), [true], "the stop, made while held, is kept");
});

for (const action of ["stop", "delete"]) {
  test(`a live resident's ${action}: a role lost during the kill stops the refresh, the stop fact and the removal`, { skip: SKIP }, async (t) => {
    for (const lose of [true, false]) {
      const f = await fixture(t, { record: true });
      const holder = f.residents(`http://127.0.0.1:${lose ? 4 : 5}`);
      assert.equal(await holder.acquire(), true);
      const ports = f.ports(holder, { onKill: lose ? () => holder.release({ waitMs: 0 }) : undefined });
      assert.equal(ports.rawIdentity("lead").current?.lifetime, L1, "the resident is not running in the fixture");
      const answer = await ports.lifecycle.execute(await f.request(action, L1));
      assert.deepEqual(f.kills, [PID], "the kill was made while the role was held");
      if (lose) {
        assert.equal(fs.existsSync(f.recordFile), true, "the post-kill refresh removed a record after the role was lost");
        assert.deepEqual(outcome(answer), ["failed", "execution-unknown"]);
        assert.deepEqual(f.stopFact(holder), [], "the stop fact was written after the role was lost");
        assert.equal(await f.defined(), true, "the definition was removed after the role was lost");
      } else {
        assert.deepEqual(outcome(answer), ["done", action], "control: the holder completes");
        assert.equal(fs.existsSync(f.recordFile), false, "control: the holder's refresh removes the ended record");
        assert.deepEqual(f.stopFact(holder), [true]);
        assert.equal(await f.defined(), action !== "delete");
      }
    }
  });
}
