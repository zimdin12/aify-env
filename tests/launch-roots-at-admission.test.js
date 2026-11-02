// A launch root added or removed WHILE a claim, a start control or a lifecycle start is waiting counts at the point
// that admits it (review of e130408, R1): the roots are read after the network waits, not snapshotted before them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runClaimPass } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { workspaceWithinRoots } from "../lib/workspace-roots.mjs";

const WORK = "D:/Games/terraria-manager";
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Roots a test changes while something waits: the supplier is asked, never copied. */
function liveRoots(initial) {
  let roots = [...initial];
  return { supplier: async () => roots, set: (next) => { roots = [...next]; } };
}

async function claimWhile(change) {
  const roots = liveRoots(change.before);
  const held = defer();
  const reports = [];
  const api = { claim: () => held.promise, report: async (id, patch) => { reports.push(patch.status); } };
  const pass = runClaimPass({ api, environmentId: "e", machineId: "m", cwdRoots: roots.supplier, windows: true });
  await tick();
  roots.set(change.after);
  held.resolve({ spawnRequest: { id: "s1", workspace: WORK } });
  return { result: await pass, reports };
}

test("CLAIM: a root removed while the claim waits refuses the spawn", async () => {
  const { result, reports } = await claimWhile({ before: ["C:/", "D:/"], after: ["C:/"] });
  assert.equal(result.outcome, "refused", "the claim was judged against the roots from before its wait");
  assert.deepEqual(reports, ["failed"]);
});

test("CLAIM: a root added while the claim waits admits the spawn", async () => {
  const { result } = await claimWhile({ before: ["C:/"], after: ["C:/", "D:/"] });
  assert.notEqual(result.outcome, "refused", "an added root did not count for a claim already waiting");
});

test("CLAIM CONTROL: unchanged roots admit, as before", async () => {
  const { result } = await claimWhile({ before: ["C:/", "D:/"], after: ["C:/", "D:/"] });
  assert.notEqual(result.outcome, "refused");
});

async function startWhile(change) {
  const roots = liveRoots(change.before);
  const held = defer();
  const starts = [];
  const api = { launch: () => held.promise, reportControl: async () => {}, claimControls: async () => ({ controls: [] }),
    terminalOutput: async () => ({ ok: true, terminal: { status: "attached" } }) };
  const processes = { list: () => [], start: async (spec) => { starts.push(spec); return { id: "h1", pid: 1 }; },
    subscribe: () => () => {} };
  const run = runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start", cols: 80, rows: 24 },
    api, processes, handles: createHandleBook(), cwdRoots: roots.supplier, windows: true, withinRoots: workspaceWithinRoots,
    buildSpec: () => ({ spec: { command: "C:/bin/worker", args: [], cwd: WORK } }), resolveCandidates: () => ["C:/bin/worker"],
    baseEnv: {}, sender: { send() {}, async drained() { return true; }, forget() {} },
  });
  await tick();
  roots.set(change.after);
  held.resolve({ launch: { argv: ["worker"], cwd: WORK, agentId: "a1", runtime: "claude-code" } });
  return { result: await run, starts };
}

test("START CONTROL: a root removed while the launch is fetched refuses the start, and nothing starts", async () => {
  const { result, starts } = await startWhile({ before: ["C:/", "D:/"], after: ["C:/"] });
  assert.equal(result.outcome, "refused", "the start was judged against the roots from before its wait");
  assert.match(result.detail, /outside this environment's advertised roots/);
  assert.equal(starts.length, 0, "a process started under a removed root");
});

test("START CONTROL: a root added while the launch is fetched admits the start", async () => {
  const { starts } = await startWhile({ before: ["C:/"], after: ["C:/", "D:/"] });
  assert.equal(starts.length, 1, "an added root did not count for a start already waiting");
});

test("START CONTROL: unchanged roots start, as before", async () => {
  const { starts } = await startWhile({ before: ["C:/", "D:/"], after: ["C:/", "D:/"] });
  assert.equal(starts.length, 1);
});
