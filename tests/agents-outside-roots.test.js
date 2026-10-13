// A managed agent whose workspace is outside the folder aify-env was started in cannot be started by it, and nothing said
// so until a spawn was refused (2026-10-13: started in C:\Docker\aify-comms, dashboard-manager at C:/Docker/aify-dashboard
// and nearly every other managed agent refused). The startup warning and the `agents-outside-roots` doctor row both
// come from `definitionsOutsideRoots`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { agentsOutsideRootsCheck, definitionsOutsideRoots, outsideRootsWarning } from "../lib/definition-checks.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const ROOTS = ["C:\\Docker\\aify-comms"];
const managed = (id, workspace) => ({ id, agent: { mode: "managed", workspace } });
const DEFINITIONS = [
  managed("dashboard-manager", "C:/Docker/aify-dashboard"),
  managed("gov-tui", "c:/docker/AIFY-COMMS/tui"),
  { id: "pc-manager", agent: { mode: "resident", workspace: "C:\\Docker" } },
];

test("A MANAGED AGENT OUTSIDE THE ROOTS is named; one inside (any case, on Windows) and a resident are not", () => {
  assert.deepEqual(definitionsOutsideRoots(DEFINITIONS, ROOTS, { windows: true }),
    [{ id: "dashboard-manager", workspace: "C:/Docker/aify-dashboard" }]);
});

test("OFF WINDOWS, case is a different folder", () => {
  assert.deepEqual(definitionsOutsideRoots([managed("a", "/home/Bob/work")], ["/home/bob"], { windows: false }),
    [{ id: "a", workspace: "/home/Bob/work" }]);
  assert.deepEqual(definitionsOutsideRoots([managed("a", "/home/bob/work")], ["/home/bob"], { windows: false }), []);
});

test("THE STARTUP WARNING names the agent, its workspace, the roots and the fix, and is silent when none are outside", () => {
  const warning = outsideRootsWarning(DEFINITIONS, ROOTS, { windows: true });
  assert.match(warning, /dashboard-manager \(C:\/Docker\/aify-dashboard\)/);
  assert.match(warning, /C:\\Docker\\aify-comms/);
  assert.match(warning, /start it again from a folder that contains them/);
  assert.equal(outsideRootsWarning(DEFINITIONS.slice(1), ROOTS, { windows: true }), "");
});

test("THE DOCTOR ROW fails naming them, passes when none, and is unanswered without evidence", () => {
  const listed = { definitions: DEFINITIONS };
  const failing = agentsOutsideRootsCheck({ answered: true, roots: ROOTS, listed, windows: true });
  assert.equal(failing.state, STATE.FAILED);
  assert.match(failing.detail, /dashboard-manager/);
  assert.match(failing.fix, /start it again from a folder that contains them/);
  assert.equal(agentsOutsideRootsCheck({ answered: true, roots: ["C:\\"], listed, windows: true }).state, STATE.PASSED);
  for (const input of [{ answered: false }, { answered: true, roots: null, listed }, { answered: true, roots: [], listed },
    { answered: true, roots: ROOTS, listed: null }]) {
    assert.equal(agentsOutsideRootsCheck({ ...input, windows: true }).state, STATE.UNANSWERED, JSON.stringify(input));
  }
});

test("THE ROW IS COLLECTED from the daemon's own /health roots when the doctor can read definitions", async () => {
  const base = {
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ supported: true, reason: "" }),
    readCredentialStore: async () => ({ names: [] }),
    endpoint: "http://127.0.0.1:8802",
    windows: true,
    knock: async () => ({ ok: true, status: 200, body: {
      status: "healthy", pid: 1, instance: "i1", processes: [], unknown: [], terminals: {}, cwdRoots: ROOTS } }),
  };
  const row = (checks) => checks.find((check) => check.id === "agents-outside-roots");
  const collected = row(await collectEnvironmentChecks({ ...base, listDefinitions: async () => ({ definitions: DEFINITIONS }) }));
  assert.equal(collected?.state, STATE.FAILED);
  assert.equal(row(await collectEnvironmentChecks(base)), undefined, "the view, which cannot read definitions, gets no row");
});

test("/health CARRIES THE FOLDERS this daemon was started in, and null when it does not say", async () => {
  const base = { runner: { list: () => [] }, readFile: () => "", version: "0.0.0", unknown: [], terminals: {}, traffic: {} };
  const health = async (deps) => (await handleRequest({ method: "GET", path: "/health" }, { ...base, ...deps })).body;
  assert.deepEqual((await health({ cwdRoots: ROOTS })).cwdRoots, ROOTS);
  assert.equal((await health({})).cwdRoots, null);
});
