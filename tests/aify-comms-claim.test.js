// Claiming a spawn request, and the refusal paths that only happen when something is already wrong.
//
// WHY THE REFUSALS GET THE MOST TESTS. The happy path is exercised the moment anyone spawns; the
// paths below run only when a service is down, a workspace is out of bounds, or a launcher is
// missing -- and those are the ones this project has repeatedly found broken in production, because
// nothing routine reaches them. Every one of them must REPORT: a claimed request the service never
// hears about again is one it will hand to nobody else, so the agent waits for ever while the
// dashboard shows a spawn that is neither running nor failed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAIM_FAILED,
  CLAIM_RUNNING,
  CLAIM_STARTING,
  runClaimPass,
  workspaceWithinRoots,
} from "../lib/plugins/aify-comms/claim.mjs";

const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

//: A launcher the allowlist accepts. It judges CONTENTS, not names: a shebang declaring the
//: interpreter, and a HARNESS_WRAPPER_VERSION marker, because enrolment is by carrying the contract
//: rather than by being named in a list. Injected so these tests need no file on disk.
const LAUNCHER_TEXT = "#!/usr/bin/env bash" + NEWLINE + 'HARNESS_WRAPPER_VERSION="1.0.0"' + NEWLINE;
const FS = { readFile: () => LAUNCHER_TEXT, platform: "win32" };

/** An api stand-in that records every report, which is what most assertions read. */
function fakeApi({ request = null, claimThrows = null } = {}) {
  const reports = [];
  return {
    reports,
    async claim() {
      if (claimThrows) throw new Error(claimThrows);
      return request ? { spawnRequest: request } : {};
    },
    async report(id, patch) { reports.push({ id, ...patch }); },
  };
}

function fakeProcesses({ startThrows = null, started = { id: "proc-1", pid: 4242 } } = {}) {
  const starts = [];
  return {
    starts,
    async start(spec) {
      starts.push(spec);
      if (startThrows) throw new Error(startThrows);
      return started;
    },
  };
}

const REQUEST = {
  id: "req-1",
  agentId: "sc-lead",
  workspace: "C:/Users/Administrator/sand_castle",
  launcher: "claude-aify",
  args: ["--managed"],
};

const ROOTS = ["C:/Users/Administrator", "C:/Docker"];

// -- the boundary guard ---------------------------------------------------------------------

test("a workspace inside an advertised root is allowed", () => {
  assert.equal(workspaceWithinRoots("C:/Users/Administrator/sand_castle", ROOTS, { windows: true }), true);
});

test("a workspace outside every root is refused", () => {
  assert.equal(workspaceWithinRoots("C:/Windows/System32", ROOTS, { windows: true }), false);
});

test("a prefix that is not a path segment does not count", () => {
  // Without the separator check a root of `/home/bo` admits `/home/bob`, which is a different user.
  assert.equal(workspaceWithinRoots("/home/bob", ["/home/bo"]), false);
  assert.equal(workspaceWithinRoots("/home/bo/work", ["/home/bo"]), true);
});

test("backslashes are normalised, so a Windows path matches a forward-slash root", () => {
  const windowsPath = "C:" + BACKSLASH + "Users" + BACKSLASH + "Administrator" + BACKSLASH + "sand_castle";
  assert.equal(workspaceWithinRoots(windowsPath, ROOTS, { windows: true }), true);
});

test("case folding is Windows-only", () => {
  // `C:/Users` and `c:/users` are one directory on Windows and two everywhere else. Folding
  // unconditionally would let `/home/Bob` pass for a root of `/home/bob`.
  assert.equal(workspaceWithinRoots("c:/users/administrator/x", ROOTS, { windows: true }), true);
  assert.equal(workspaceWithinRoots("/home/Bob", ["/home/bob"], { windows: false }), false);
});

test("an empty workspace is refused, not treated as the root", () => {
  assert.equal(workspaceWithinRoots("", ROOTS, { windows: true }), false);
  assert.equal(workspaceWithinRoots("C:/Docker", [""], { windows: true }), false);
});

// -- the pass -------------------------------------------------------------------------------

test("nothing to claim is idle, not an error", async () => {
  const api = fakeApi();
  const result = await runClaimPass({ api, processes: fakeProcesses(), environmentId: "e", cwdRoots: ROOTS, ...FS });
  assert.equal(result.outcome, "idle");
  assert.deepEqual(api.reports, [], "an idle pass must report nothing");
});

test("a service that is down is reported, never thrown", async () => {
  // A host that threw here would stop the next pass from ever trying, and aify-env's own job does
  // not depend on any service being reachable.
  const api = fakeApi({ claimThrows: "connect ECONNREFUSED" });
  const result = await runClaimPass({ api, processes: fakeProcesses(), environmentId: "e", cwdRoots: ROOTS, ...FS });
  assert.equal(result.outcome, "unreachable");
  assert.match(result.detail, /ECONNREFUSED/);
});

test("a claimed request outside the roots is REPORTED failed, not silently dropped", async () => {
  const api = fakeApi({ request: { ...REQUEST, workspace: "C:/Windows/System32" } });
  const processes = fakeProcesses();
  const result = await runClaimPass({ api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true, ...FS });
  assert.equal(result.outcome, "refused");
  assert.deepEqual(processes.starts, [], "nothing may be launched outside the advertised roots");
  assert.equal(api.reports.length, 1);
  assert.equal(api.reports[0].status, CLAIM_FAILED);
  assert.match(api.reports[0].error, /outside this environment/);
});

test("a launcher that will not start is reported with the HOST's own reason", async () => {
  // "The agent did not start" is what this looked like from the dashboard, minutes later, with the
  // cause discarded here.
  const api = fakeApi({ request: REQUEST });
  const processes = fakeProcesses({ startThrows: "spawn claude-aify ENOENT" });
  const result = await runClaimPass({ api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true, ...FS });
  assert.equal(result.outcome, "failed");
  const statuses = api.reports.map((r) => r.status);
  assert.deepEqual(statuses, [CLAIM_STARTING, CLAIM_FAILED], "starting must be reported before the failure");
  assert.match(api.reports[1].error, /ENOENT/);
});

test("a good request starts and is reported running, with a handle the service can reach", async () => {
  const api = fakeApi({ request: REQUEST });
  const processes = fakeProcesses();
  const result = await runClaimPass({ api, processes, environmentId: "e", cwdRoots: ROOTS, windows: true, ...FS });
  assert.equal(result.outcome, "started");
  assert.deepEqual(api.reports.map((r) => r.status), [CLAIM_STARTING, CLAIM_RUNNING]);
  // WITHOUT THE HANDLE the service knows a spawn is running and has no way to write to it or stop it.
  assert.equal(api.reports[1].handle, "proc-1");
  assert.equal(api.reports[1].processId, "4242");
  assert.equal(processes.starts[0].cwd, REQUEST.workspace);
  assert.equal(processes.starts[0].launcher, "claude-aify");
});

test("every path that claims a request also reports it", async () => {
  // The property, asserted over all three outcomes at once rather than trusted per test: a claimed
  // request with no report is one the service will hand to nobody else.
  const cases = [
    { name: "refused", api: fakeApi({ request: { ...REQUEST, workspace: "C:/nope" } }), processes: fakeProcesses() },
    { name: "failed", api: fakeApi({ request: REQUEST }), processes: fakeProcesses({ startThrows: "ENOENT" }) },
    { name: "started", api: fakeApi({ request: REQUEST }), processes: fakeProcesses() },
  ];
  for (const c of cases) {
    await runClaimPass({ api: c.api, processes: c.processes, environmentId: "e", cwdRoots: ROOTS, windows: true, ...FS });
    assert.ok(c.api.reports.length > 0, `the ${c.name} path claimed a request and reported nothing`);
    assert.ok(c.api.reports.every((r) => r.id === REQUEST.id), `${c.name} reported against the wrong request`);
  }
});
