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
function fakeApi({ request = null, claimThrows = null, reportThrowsOn = null } = {}) {
  const reports = [];
  return {
    reports,
    async claim() {
      if (claimThrows) throw new Error(claimThrows);
      return request ? { spawnRequest: request } : {};
    },
    async report(id, patch) {
      reports.push({ id, ...patch });
      // A service that ACCEPTS `starting` and refuses `running` is the shape that strands a request:
      // it is claimed, the dashboard shows it moving, and nothing ever settles it.
      if (reportThrowsOn && patch.status === reportThrowsOn) throw new Error("refused by the service");
    },
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

test("A CLAIM REGISTERS A WARM AGENT AND STARTS NOTHING", async () => {
  // THE MODEL THIS FILE GOT WRONG, and the first real spawn found it: six requests were claimed
  // within seconds on 2026-09-03 and all six failed with "a start request must name a launcher to
  // run", because the pass built a start spec from `request.launcher` -- a field the wire has never
  // carried. The spec carries `runtime`; nothing needed a launcher at claim time.
  //
  // MEASURED against the code this replaced: `mcp/stdio/spawn-loop.mjs`, the bridge's claim
  // consumer, contains ZERO process starts. It reports `running` with its own pid and the worker is
  // started later, by the terminal control path, when the service asks. That is `managed-warm`, and
  // every spawn this system issues uses it.
  const api = fakeApi({ request: REQUEST });
  const result = await runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true, pid: 4242 });
  assert.equal(result.outcome, "registered");
  assert.deepEqual(api.reports.map((r) => r.status), [CLAIM_STARTING, CLAIM_RUNNING]);
});

test("the report carries THIS DAEMON'S pid, not a worker's", async () => {
  // The worker does not exist yet. Reporting anything else would put a pid in the row that nothing
  // is running -- and the bridge reported its own pid here for exactly the same reason.
  const api = fakeApi({ request: REQUEST });
  await runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true, pid: 4242 });
  assert.equal(api.reports[1].processId, "4242");
});

test("the report names the environment and request, and invents nothing else", async () => {
  // Reporting `running` is what the service calls "convert a spawn request into a live agent": it
  // writes the agents and sessions rows and derives the runtime's capabilities ITSELF. So this
  // sends only the facts this host knows. A capability table here would be a second copy of one the
  // service already owns, agreeing until one of them is fixed.
  const api = fakeApi({ request: REQUEST });
  await runClaimPass({ api, environmentId: "windows:h:default", cwdRoots: ROOTS, windows: true });
  const running = api.reports[1];
  assert.equal(running.runtimeState.environmentId, "windows:h:default");
  assert.equal(running.runtimeState.spawnRequestId, REQUEST.id);
  assert.equal(running.runtimeState.mode, "managed-warm");
  assert.equal(running.capabilities, undefined, "capabilities are the service's to derive");
});

test("a service that refuses the running report leaves the outcome FAILED, not silently registered", async () => {
  // A claimed request the service never hears about again is one it hands to nobody else: the agent
  // waits for ever and the dashboard shows a spawn that is neither running nor failed.
  const api = fakeApi({ request: REQUEST, reportThrowsOn: CLAIM_RUNNING });
  const result = await runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true });
  assert.equal(result.outcome, "failed");
  assert.match(result.detail, /refused/i);
});

test("every path that claims a request also reports it", async () => {
  // The property, asserted over all three outcomes at once rather than trusted per test: a claimed
  // request with no report is one the service will hand to nobody else.
  const cases = [
    { name: "refused", api: fakeApi({ request: { ...REQUEST, workspace: "C:/nope" } }) },
    { name: "registered", api: fakeApi({ request: REQUEST }) },
  ];
  for (const c of cases) {
    await runClaimPass({ api: c.api, environmentId: "e", cwdRoots: ROOTS, windows: true });
    assert.ok(c.api.reports.length > 0, `the ${c.name} path claimed a request and reported nothing`);
    assert.ok(c.api.reports.every((r) => r.id === REQUEST.id), `${c.name} reported against the wrong request`);
  }
});

// ── a refused REPORT must not escape the pass ────────────────────────────────────────────────────
//
// EXTERNAL REVIEW, Round 8 H2. `api.claim` was wrapped; the two `api.report` calls were bare awaits.
// A throw from either escaped `runClaimPass`, escaped `claimForever` (try/finally, no catch), and
// landed in a one-shot `.catch` -- so this host stopped claiming until it was restarted, while the
// SEPARATE heartbeat loop kept `bridgeLastSeen` fresh and every instrument read healthy.
//
// The `running` report was already covered. These are the two that were not, and the trigger is
// ordinary: `PATCH /spawn-requests/{id}` answers 409 when the operator cancels between claim and
// report.

test("a refused STARTING report ends the pass, not the loop", async () => {
  const api = fakeApi({ request: REQUEST, reportThrowsOn: CLAIM_STARTING });
  const result = await runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true });
  assert.equal(result.outcome, "report-refused",
    "a 409 on `starting` threw out of the pass; one cancelled spawn request then stops this host "
    + "claiming anything for the life of the process");
  assert.equal(result.spawnRequestId, REQUEST.id);
});

test("a refused STARTING report does NOT go on to register the agent", async () => {
  // The request is no longer ours to act on: a 409 means the service took the claim back. Carrying
  // on would register a warm agent for a request somebody cancelled.
  const api = fakeApi({ request: REQUEST, reportThrowsOn: CLAIM_STARTING });
  await runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true });
  assert.deepEqual(api.reports.map((r) => r.status), [CLAIM_STARTING],
    "the pass carried on past a refused claim and reported again");
});

test("a refused FAILED report still returns the refusal", async () => {
  // The out-of-roots path. Its report was the other bare await, and this is the case where the
  // service is already unhappy -- exactly when a second failure is most likely.
  const api = fakeApi({ request: { ...REQUEST, workspace: "C:/nope" }, reportThrowsOn: CLAIM_FAILED });
  const result = await runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true });
  assert.equal(result.outcome, "refused",
    "a refused `failed` report threw out of the pass instead of leaving the refusal standing");
});

test("NO report failure can throw out of a pass, over every status the pass sends", async () => {
  // THE PROPERTY, over a DERIVED population rather than the three cases above: whichever status a
  // future pass learns to send, refusing it must cost that pass and never the loop. A test per
  // status is a list somebody has to remember to extend.
  for (const status of [CLAIM_STARTING, CLAIM_RUNNING, CLAIM_FAILED]) {
    const api = fakeApi({ request: REQUEST, reportThrowsOn: status });
    await assert.doesNotReject(
      () => runClaimPass({ api, environmentId: "e", cwdRoots: ROOTS, windows: true }),
      `a refused ${status} report threw out of the pass`,
    );
  }
});

