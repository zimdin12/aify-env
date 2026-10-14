// Which lifetimes a host owns (B1 contract items 2, 6 and 10): the daemon's managed host adopts no resident record and
// lists no resident, the residents host lists only residents, and a record stamped `default` by a launcher from before
// the role is unbound: adopted by neither, removed by neither (the operator's ruling on that class is pending).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStateHost } from "../lib/agent-state-host.mjs";

const WRITTEN = 1_790_950_000_500_123;
const NOW = WRITTEN + 60_000_000;
const lifetime = (n) => `7f3c9e2a-0000-4000-8000-${String(n).padStart(12, "0")}`;
const running = { alive: true, createdAtUs: WRITTEN - 5, commandLine: `bash.exe /c/x/claude-aify` };
const gone = { alive: false, createdAtUs: null, commandLine: null };

function homeWith(t, records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-populations-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "residents"));
  for (const r of records) fs.writeFileSync(path.join(home, "residents", `${r.agentId}.${r.lifetime}.json`), JSON.stringify({
    harness: "claude", launcher: "C:/x/claude-aify", writtenAtUs: WRITTEN, ...r }));
  return home;
}
const host = (home, instance, population, answers) => new AgentStateHost({ aifyHome: home, instance, population, nowUs: () => NOW,
  probe: (pids) => new Map(pids.map((pid) => [pid, answers[pid] ?? gone])) });
const given = (...ids) => new Map(ids.map((id) => [id, { definition: "valid", stoppedByOperator: false }]));
const ids = (read) => read.agents.map((row) => row.agentId);

test("the managed host adopts no resident record, whatever instance it names, and lists no resident", (t) => {
  const home = homeWith(t, [
    { agentId: "res", lifetime: lifetime(1), instance: "residents", pid: 41 },
    { agentId: "legacy", lifetime: lifetime(2), instance: "default", pid: 42 },
    { agentId: "dead-legacy", lifetime: lifetime(3), instance: "default", pid: 43 },
  ]);
  const managed = host(home, "default", "managed", { 41: running, 42: running });
  managed.boot();
  managed.startManaged({ agentId: "worker", lifetime: lifetime(9), instance: "default", pid: 99, handle: "p1" });
  const read = managed.readAll(given("res", "legacy", "dead-legacy", "idle-defined"));
  assert.deepEqual(ids(read), ["dead-legacy", "idle-defined", "worker"],
    "a live resident record claims its agent for the residents' key, or leaves it unbound; never listed here");
  assert.equal(managed.current("legacy").lifetime, null, "a default-stamped record was adopted by the default instance");
  assert.equal(managed.current("worker").lifetime, lifetime(9));
  assert.equal(fs.existsSync(path.join(home, "residents", `dead-legacy.${lifetime(3)}.json`)), true, "an unbound record was removed");
  assert.equal(managed.rawIdentity("res").unknown, true, "a live resident nobody here answers for is unknown");
  assert.equal(managed.rawIdentity("res", { answeredElsewhere: (r) => r.instance === "residents" }).unknown, false);
  assert.equal(managed.rawIdentity("legacy", { answeredElsewhere: (r) => r.instance === "residents" }).unknown, true,
    "an unbound record is answered by nobody");
});

test("the residents host lists its residents only: no defined-only agent, no other instance's record, no managed child", (t) => {
  const home = homeWith(t, [
    { agentId: "res", lifetime: lifetime(1), instance: "residents", pid: 41 },
    { agentId: "dead-res", lifetime: lifetime(4), instance: "residents", pid: 44 },
    { agentId: "legacy", lifetime: lifetime(2), instance: "default", pid: 42 },
  ]);
  const residents = host(home, "residents", "residents", { 41: running, 42: running });
  residents.boot();
  assert.deepEqual(ids(residents.readAll(given("res", "idle-defined", "legacy"))), ["res"], "its ended record was removed at boot");
  assert.equal(residents.current("res").lifetime, lifetime(1));
  assert.equal(fs.existsSync(path.join(home, "residents", `dead-res.${lifetime(4)}.json`)), false, "its own ended record is removed");
  assert.equal(fs.existsSync(path.join(home, "residents", `legacy.${lifetime(2)}.json`)), true);
  assert.throws(() => residents.startManaged({ agentId: "w", lifetime: lifetime(9), instance: "residents", pid: 9, handle: "p" }),
    /owns no managed lifetime/);
});

test("CONTROL: the all-in-one host keeps its single-instance shape, so the populations are what changed", (t) => {
  const home = homeWith(t, [{ agentId: "legacy", lifetime: lifetime(2), instance: "default", pid: 42 }]);
  const all = host(home, "default", "all", { 42: running });
  all.boot();
  assert.equal(all.current("legacy").lifetime, lifetime(2));
  assert.deepEqual(ids(all.readAll(given("idle-defined"))), ["idle-defined", "legacy"]);
  assert.throws(() => host(home, "default", "both", {}), /not a population/);
});

test("managed lifetimes of a previous invocation are not adopted by the next managed host (contract item 10)", (t) => {
  const home = homeWith(t, []);
  const before = host(home, "default", "managed", {});
  before.boot();
  before.startManaged({ agentId: "worker", lifetime: lifetime(9), instance: "default", pid: 99, handle: "p1" });
  assert.equal(before.applyEvent({ agentId: "worker", lifetime: lifetime(9), kind: "turn-start", firedAtUs: NOW }).applied, true);
  const after = host(home, "default", "managed", { 99: running });
  after.boot();
  assert.equal(after.current("worker").lifetime, null);
  assert.deepEqual(after.applyEvent({ agentId: "worker", lifetime: lifetime(9), kind: "turn-end", firedAtUs: NOW + 1 }),
    { applied: false, reason: "not-current", lifetime: undefined });
});
