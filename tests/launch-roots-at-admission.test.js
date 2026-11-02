// A launch root added or removed WHILE a claim, a start control or a lifecycle start is waiting counts at the point
// that admits it (review of e130408, R1): the roots are read after the network waits, not snapshotted before them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runClaimPass } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { workspaceWithinRoots } from "../lib/workspace-roots.mjs";
import { automaticStartAdmission } from "../lib/plugins/aify-comms/automatic-start-admission.mjs";

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

test("START CONTROL WITHOUT ADMISSION: roots that change between prepare and the start refuse it, and nothing is remembered", async () => {
  // The first ask (prepare) admits D:/, the second (the producer, last) does not.
  let asks = 0;
  const cwdRoots = async () => { asks += 1; return asks === 1 ? ["C:/", "D:/"] : ["C:/"]; };
  const starts = [], reported = [];
  const handles = createHandleBook();
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start", cols: 80, rows: 24 },
    api: { launch: async () => ({ launch: { argv: ["worker"], cwd: WORK, runtime: "claude-code" } }),
      reportControl: async (id, patch) => { reported.push(patch); }, terminalOutput: async () => ({ ok: true }) },
    processes: { list: () => [], start: async (spec) => { starts.push(spec); return { id: "h1", pid: 1 }; }, subscribe: () => () => {} },
    handles, cwdRoots, windows: true, withinRoots: workspaceWithinRoots,
    buildSpec: () => ({ spec: { command: "C:/bin/worker", args: [], cwd: WORK } }), resolveCandidates: () => ["C:/bin/worker"],
    baseEnv: {}, sender: { send() {}, async drained() { return true; }, forget() {} },
  });
  assert.equal(asks, 2, "CONTROL: prepare and the producer each asked");
  assert.equal(starts.length, 0, "a process started under a root removed after prepare");
  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.deepEqual(handles.terminalIds(), [], "a refused start remembered a terminal");
  assert.deepEqual(reported.map((patch) => patch.status), ["failed"]);
});

// THROUGH PRODUCTION'S ADMISSION (automaticStartAdmission, which the plugin hands every start control): its definition
// read waits AFTER the launch is prepared, so a root removed during that wait must still refuse (review of eb17750).
async function admittedStartWhile(change) {
  const roots = liveRoots(change.before);
  const listHeld = defer();
  let listAsked = false;
  const definitions = { list: async () => { listAsked = true; await listHeld.promise;
    return { storeId: "s", definitions: [], unreadable: [], conflict: null, enumerationFailed: null }; } };
  const starts = [], reported = [];
  const handles = createHandleBook();
  const api = { launch: async () => ({ launch: { argv: ["worker"], cwd: WORK, runtime: "claude-code" } }),
    reportControl: async (id, patch) => { reported.push(patch); }, claimControls: async () => ({ controls: [] }),
    terminalOutput: async () => ({ ok: true, terminal: { status: "attached" } }) };
  const processes = { list: () => [], start: async (spec) => { starts.push(spec); return { id: "h1", pid: 1 }; },
    subscribe: () => () => {} };
  const run = runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start", cols: 80, rows: 24 },
    api, processes, handles, cwdRoots: roots.supplier, windows: true, withinRoots: workspaceWithinRoots,
    buildSpec: () => ({ spec: { command: "C:/bin/worker", args: [], cwd: WORK } }), resolveCandidates: () => ["C:/bin/worker"],
    baseEnv: {}, sender: { send() {}, async drained() { return true; }, forget() {} },
    admitStart: automaticStartAdmission({ definitions, agents: null }),
  });
  for (let i = 0; i < 100 && !listAsked; i += 1) await tick();
  assert.equal(listAsked, true, "CONTROL: admission is waiting on its definition read");
  roots.set(change.after);
  listHeld.resolve();
  return { result: await run, starts, reported, handles };
}

test("ADMITTED START: a root removed while admission reads the definitions refuses, starts nothing, and attaches nothing", async () => {
  const { result, starts, reported, handles } = await admittedStartWhile({ before: ["C:/", "D:/"], after: ["C:/"] });
  assert.equal(starts.length, 0, "a process started under a root removed during admission");
  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.match(result.detail, /outside this environment's advertised roots/);
  // terminalIds, not handleFor: handleFor answers "" for an unknown terminal and for one remembered with an empty handle.
  assert.deepEqual(handles.terminalIds(), [], "a refused start remembered a terminal");
  assert.deepEqual(reported.map((patch) => patch.status), ["failed"], "a refused start reported anything but one failure");
});

test("ADMITTED START CONTROL: an unchanged root starts through the same admission and attaches", async () => {
  const { starts, reported, handles } = await admittedStartWhile({ before: ["C:/", "D:/"], after: ["C:/", "D:/"] });
  assert.equal(starts.length, 1);
  assert.deepEqual(handles.terminalIds(), ["term-1"], "CONTROL: a started terminal is remembered");
  assert.ok(reported.some((patch) => patch.status === "completed"), JSON.stringify(reported));
});
