// B1 review J2: a resident that is defined but not running is published on this daemon's MANAGED key as a cold row,
// with no lifetime. When its launcher writes its `residents` record, the managed population stops listing it and the
// residents key takes it. A removal names a lifetime, which that cold row has none of, so the managed key must withdraw
// it with a whole snapshot, or the receiver keeps it current beside the residents' row until the next snapshot epoch.
// The real path a sender evaluates: definitions and the managed host through readAgentStates, then the publisher.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentStatePublisher } from "../lib/agent-state-publisher.mjs";
import { readAgentStates } from "../lib/agent-state-read.mjs";

const WRITTEN = 1_790_950_000_500_123;
const NOW = WRITTEN + 60_000_000;
const RESIDENT_LIFETIME = "7f3c9e2a-0000-4000-8000-0000000000f1";
const WORKER_LIFETIME = "7f3c9e2a-0000-4000-8000-0000000000f2";
const running = { alive: true, createdAtUs: WRITTEN - 5, commandLine: `node "${process.execPath}"` };
const gone = { alive: false, createdAtUs: null, commandLine: null };
const rows = (body) => body.agents.map((row) => [row.agentId, row.lifetime]);

test("a cold managed row is withdrawn by a snapshot when its resident starts; a running managed worker is kept", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-cold-to-resident-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const installed = new Set(["claude"]);
  const definitions = new DefinitionStore({ dir: path.join(home, "definitions") });
  const agent = (id, mode) => ({ id, name: id, role: "worker", harness: "claude", mode, workspace: home, model: "",
    effort: "", instructions: "", env: {}, herdrSpace: false });
  await definitions.set("res", agent("res", "resident"), { installed });
  await definitions.set("worker", agent("worker", "managed"), { installed });
  const managed = new AgentStateHost({ aifyHome: home, instance: "default", population: "managed", nowUs: () => NOW,
    probe: (pids) => new Map(pids.map((pid) => [pid, pid === 41 ? running : gone])) });
  managed.boot();
  managed.startManaged({ agentId: "worker", lifetime: WORKER_LIFETIME, instance: "default", pid: 99, handle: "p1" });
  const read = async () => (await readAgentStates({ stateHost: managed, definitions, observedHarnesses: async () => installed,
    lifecycle: { stopFacts: async () => new Map() } })).body;
  const publisher = new AgentStatePublisher({ machineId: "m", instance: "default", generation: 9, incarnationId: "i" });

  const acknowledged = publisher.snapshot(await read());
  assert.deepEqual(rows(acknowledged.body), [["res", null], ["worker", WORKER_LIFETIME]], "the cold resident is a managed row");
  assert.equal(publisher.changes(await read(), acknowledged.view), null, "control: a quiet evaluation sends nothing");

  // The resident's launcher writes its record, stamped with the role's instance, for a live process.
  fs.mkdirSync(path.join(home, "residents"));
  fs.writeFileSync(path.join(home, "residents", `res.${RESIDENT_LIFETIME}.json`), JSON.stringify({ agentId: "res",
    lifetime: RESIDENT_LIFETIME, instance: "residents", harness: "claude", pid: 41, launcher: process.execPath, writtenAtUs: WRITTEN }));
  const after = await read();
  assert.equal(after.complete, true, JSON.stringify(after.problems));
  assert.deepEqual(rows(after), [["worker", WORKER_LIFETIME]], "the managed population let the resident go");

  const withdrawal = publisher.changes(after, acknowledged.view);
  assert.equal(withdrawal?.body.kind, "snapshot", "the cold row of res stays current on the managed key");
  assert.deepEqual(rows(withdrawal.body), [["worker", WORKER_LIFETIME]], "control: the running managed worker was withdrawn");
  assert.deepEqual(withdrawal.body.removed, [], "a removal was invented for a row with no lifetime");
  assert.equal(publisher.changes(after, withdrawal.view), null, "once acknowledged, nothing is left to send");
});
