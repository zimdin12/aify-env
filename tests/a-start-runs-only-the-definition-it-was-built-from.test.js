#!/usr/bin/env node
// The process-start boundary (P0 C7): a launch the service built from a definition starts only while
// this host's file is that definition. Driven through the real control path with a real store; the
// launch is what `GET /terminals/{id}/launch` returns.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRefusal } from "../lib/agent-definition-requests.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const agent = (over = {}) => ({ name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/work",
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true, ...over });

function host(launch) {
  const reports = [];
  const starts = [];
  const api = {
    async launch() { return { launch }; },
    async reportControl(id, patch) { reports.push({ id, ...patch }); },
    async terminalOutput() { return {}; },
  };
  const processes = {
    async start(spec) { starts.push(spec); return { id: "proc-1", pid: 1, cols: 80, rows: 24 }; },
    subscribe() { return () => {}; },
    list() { return []; },
  };
  return { api, processes, reports, starts };
}

async function startWith(store, launch) {
  const { api, processes, reports, starts } = host(launch);
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, api, processes, handles: createHandleBook(),
    cwdRoots: ["C:/work"], windows: true, withinRoots: workspaceWithinRoots,
    buildSpec: ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } }),
    resolveCandidates: () => ["C:/bin/claude-aify"], baseEnv: {},
    checkStart: async (built) => startRefusal(built, await store.list()),
  });
  return { result, reports, starts };
}

async function definedLead() {
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-boundary-")), lockWaitMs: 300 });
  await store.set("lead", agent(), { installed: ALL });
  const { storeId } = await store.list();
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: ["claude-aify", "--aify-agent", "lead"],
    cwd: "C:/work", env: {}, definition: { storeId, incarnation: 1, revision: 1 } };
  return { store, launch };
}

test("THE DEFINITION IT WAS BUILT FROM: it starts; and a launch with no definition is not checked", async () => {
  const { store, launch } = await definedLead();
  assert.equal((await startWith(store, launch)).result.outcome, "started");
  const plain = await startWith(store, { ...launch, agentId: "nobody-defines-this", definition: null });
  assert.equal(plain.result.outcome, "started", "an undefined agent's launch carries none and starts");
});

for (const [label, change, reason] of [
  ["changed since it was queued", (store) => store.set("lead", agent({ model: "m2" }), { installed: ALL }),
    "lead changed since this start was queued: revision 1 -> 2; start it again"],
  ["withdrawn", (store) => store.remove("lead"), "lead was withdrawn on this host"],
]) {
  test(`A DEFINITION ${label.toUpperCase()} refuses the start before any process exists`, async () => {
    const { store, launch } = await definedLead();
    await change(store);
    const { result, reports, starts } = await startWith(store, launch);
    assert.deepEqual([result.outcome, result.detail], ["refused", reason]);
    assert.deepEqual(starts, [], "no process was started");
    assert.deepEqual(reports.map((r) => [r.status, r.error]), [["failed", reason]], "the control says why");
  });
}
