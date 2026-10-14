// The host rows that moved here from `aify-comms doctor` (0.9.7, plan D11) reach the report, through the
// same code the doctor runs: the verdict-to-row mapping, the core collector that asks the plugin registry
// by name, the comms plugin's entry and its real reader, and the environment report that appends them.
//
// The checks' own logic is proven in the host-doctor-<check>.test.js files beside this one. This file is
// about the calls between them, which is where a proven helper with no call site hides.

import assert from "node:assert/strict";
import { test } from "node:test";

import { fromVerdict } from "../lib/health.mjs";
import { collectHostChecks, jsonFromKnock } from "../lib/host-checks.mjs";
import { doctorChecksFor } from "../lib/plugins/index.mjs";
import { commsDoctorChecks, serviceReads } from "../lib/plugins/aify-comms/doctor-checks.mjs";
import { readsOf } from "./_comms-reads.mjs";
import { checkManagedOrphans, envCanClaimASpawnAt, cmdlineDeliveryLoopAgent } from "../lib/plugins/aify-comms/managed-orphans-check.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { codeCurrentCheck } from "../lib/environment-checks.mjs";
import { listHostProcesses, parsePosixListing, parseWindowsListing } from "../lib/process-list.mjs";

// ── the verdict a moved check produces, as this doctor's row ─────────────────────────────────────────

test("a verdict keeps its code on every state", () => {
  assert.deepEqual(fromVerdict("x", { ok: true, code: "ok", detail: "d" }), { id: "x", state: "passed", detail: "d", fix: "", code: "ok" });
  assert.deepEqual(fromVerdict("x", { ok: false, code: "exhausted", detail: "d", fix: "f" }), { id: "x", state: "failed", detail: "d", fix: "f", code: "exhausted" });
  assert.equal(fromVerdict("x", { ok: false, code: "unknown-all", detail: "d", fix: "f" }).state, "unanswered");
  assert.equal(fromVerdict("x", { ok: false, code: "unknown", detail: "d" }).state, "unanswered");
});

test("NOT APPLICABLE passes with code skipped; a failing partial is still a failure", () => {
  // `skipped` is a question that does not apply here. `partial` with ok:false is context-window's capped
  // fan-out, which aify-comms rendered with a benign glyph once; here it is a failed row.
  const skipped = fromVerdict("x", { ok: true, code: "skipped", detail: "n/a" });
  assert.equal(skipped.state, "passed");
  assert.equal(skipped.code, "skipped");
  assert.equal(fromVerdict("x", { ok: false, code: "partial", detail: "d", fix: "f" }).state, "failed");
});

test("a failure without a fix is refused, as every failed row here is", () => {
  assert.throws(() => fromVerdict("x", { ok: false, code: "orphaned", detail: "d" }), /must carry a fix/);
});

// ── the core collector: asks the registry by name, and names no service itself ───────────────────────

test("only a registered service whose plugin answers adds rows, and claude-login comes last", async () => {
  const asked = [];
  const rows = await collectHostChecks({
    services: [{ name: "aify-dashboard", endpoint: "http://d" }, { name: "aify-comms", endpoint: "http://c" }],
    endpoint: "http://127.0.0.1:8802",
    knock: async () => ({ ok: false }),
    machineId: "win32:host",
    listProcesses: () => [],
    credentialFor: async (service) => `key-for-${service.name}`,
    claudeLogin: () => ({ id: "claude-login", state: "passed", detail: "", fix: "", code: "skipped" }),
    doctorChecksFor: (name) => (name === "aify-comms"
      ? async (deps) => {
        asked.push({ endpoint: deps.service.endpoint, key: await deps.credential(), env: deps.envEndpoint, machine: deps.machineId });
        return [{ id: "from-comms", state: "passed", detail: "", fix: "" }];
      }
      : null),
  });
  assert.deepEqual(rows.map((row) => row.id), ["from-comms", "claude-login"]);
  assert.deepEqual(asked, [{ endpoint: "http://c", key: "key-for-aify-comms", env: "http://127.0.0.1:8802", machine: "win32:host" }]);
});

test("with no service registered, only the core's own row is asked", async () => {
  const rows = await collectHostChecks({
    services: [], endpoint: "e", knock: async () => ({}), machineId: "m", listProcesses: () => [],
    credentialFor: async () => "", claudeLogin: () => ({ id: "claude-login" }),
    doctorChecksFor: () => assert.fail("a contributor was looked up with no service registered"),
  });
  assert.deepEqual(rows.map((row) => row.id), ["claude-login"]);
});

test("the registry maps aify-comms to its doctor rows, and nothing else to any", () => {
  assert.equal(doctorChecksFor("aify-comms"), commsDoctorChecks);
  assert.equal(doctorChecksFor("aify-dashboard"), null);
  assert.equal(doctorChecksFor(""), null);
});

test("a knock that answered with an error page is not a listing", () => {
  assert.equal(jsonFromKnock({ ok: true, status: 404, body: { detail: "Not Found" } }), null);
  assert.equal(jsonFromKnock({ ok: false, error: "ECONNREFUSED" }), null);
  assert.deepEqual(jsonFromKnock({ ok: true, status: 200, body: { processes: [] } }), { processes: [] });
});

// ── the comms plugin's entry: three rows, with their ids and codes ─────────────────────────────────

const LIVE_BRIDGE = "5fdddb0f-489b-4a05-aecd-bd4d14f07ccb";
const NOW = Date.parse("2026-10-14T12:00:00Z");

function fleet({ agents = {}, terminals = [], environments = [], bridges = [], consoles = {} } = {}) {
  return async (path) => {
    if (path === "/agents") return { agents };
    if (path.startsWith("/terminals")) return { terminals };
    if (path === "/environments") return { environments };
    if (path === "/bridges") return { bridges };
    const match = /^\/agents\/([^/]+)\/console/.exec(path);
    return match ? consoles[decodeURIComponent(match[1])] ?? null : null;
  };
}

test("the comms rows arrive in order, each with its id, state and code", async () => {
  const rows = await commsDoctorChecks({
    service: { name: "aify-comms", endpoint: "http://comms" },
    credential: async () => "",
    envEndpoint: "http://127.0.0.1:8802",
    fetchJson: async () => ({ processes: [] }),
    machineId: "win32:host",
    listProcesses: () => [{ pid: process.pid, ppid: 0, commandLine: "node doctor" }],
    reads: readsOf(fleet({
      agents: { worker: { consoleAvailable: true, sessionMode: "managed", runtime: "hermes" } },
      consoles: { worker: { live: true, output: " │ 922.4k/900k │ " } },
      bridges: [{ id: LIVE_BRIDGE }],
    })),
  });
  assert.deepEqual(rows.map((row) => [row.id, row.state, row.code]), [
    ["env-processes", "passed", "ok"],
    ["context-window", "failed", "exhausted"],
    ["managed-orphans", "passed", "none"],
  ]);
});

test("a service that does not answer leaves every comms row UNANSWERED, never passed", async () => {
  const rows = await commsDoctorChecks({
    service: { name: "aify-comms", endpoint: "http://comms" },
    credential: async () => "",
    envEndpoint: "http://127.0.0.1:8802",
    fetchJson: async () => ({ processes: [] }),
    machineId: "win32:host",
    listProcesses: () => [{ pid: process.pid, ppid: 0, commandLine: "node doctor" }],
    reads: readsOf(async () => null),
  });
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [
    ["env-processes", "unanswered"],
    ["context-window", "unanswered"],
    ["managed-orphans", "unanswered"],
  ]);
});

test("the real reader sends the resolved key to /api/v1 and turns a refusal into null", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, key: init.headers["X-API-Key"], redirect: init.redirect });
    if (url.endsWith("/api/v1/agents")) return new Response(JSON.stringify({ agents: {} }), { status: 200 });
    return new Response("no", { status: 401 });
  };
  const rows = await commsDoctorChecks({
    service: { name: "aify-comms", endpoint: "http://comms.invalid:1" },
    credential: async () => "the-key",
    envEndpoint: "",
    fetchJson: async () => null,
    machineId: "m",
    listProcesses: () => [{ pid: process.pid, ppid: 0, commandLine: "x" }],
    fetchImpl,
  });
  assert.ok(seen.length > 0, "the reader never sent anything");
  assert.ok(seen.every((call) => call.key === "the-key" && call.redirect === "manual"), JSON.stringify(seen));
  assert.ok(seen.some((call) => call.url === "http://comms.invalid:1/api/v1/agents"));
  // /agents answered, so context-window measured an empty fleet; /environments was refused, so the
  // orphan count has nothing to compare against.
  assert.equal(rows.find((row) => row.id === "context-window").code, "none");
  assert.equal(rows.find((row) => row.id === "managed-orphans").state, "unanswered");
});

test("serviceReads answers null for a throw, the body otherwise, and offers only reads", async () => {
  const reads = serviceReads({
    agents: async () => { throw new Error("refused"); },
    agentConsole: async (id, lines) => ({ id, lines }),
    heartbeat: async () => assert.fail("a write reached the doctor's reads"),
  });
  assert.equal(await reads.agents(), null);
  assert.deepEqual(await reads.agentConsole("a", 6), { id: "a", lines: 6 });
  assert.equal(reads.heartbeat, undefined);
  assert.deepEqual(Object.keys(reads).sort(), ["agentConsole", "agents", "bridges", "environments", "liveTerminals"]);
});

// ── managed-orphans: the gather, which aify-comms ran inline and never tested ──────────────────────

function orphanRun({ rows, environments = [], bridges = [], agents = {} }) {
  const added = [];
  return checkManagedOrphans({
    reads: readsOf(fleet({ agents, environments, bridges })),
    add: (...args) => added.push(args),
    listProcesses: () => { if (rows instanceof Error) throw rows; return rows; },
    selfPid: 7,
    now: () => NOW,
  }).then(() => added[0]);
}

test("an unreadable process table is unknown and named", async () => {
  const [, ok, code, detail] = await orphanRun({ rows: new Error("powershell failed"), bridges: [{ id: LIVE_BRIDGE }] });
  assert.equal(ok, false);
  assert.equal(code, "unknown-all");
  assert.match(detail, /process table/);
});

test("a listing that does not contain this process did not read the host", async () => {
  const [, , code, detail] = await orphanRun({ rows: [{ pid: 99, commandLine: "x" }], bridges: [{ id: LIVE_BRIDGE }] });
  assert.equal(code, "unknown-all");
  assert.match(detail, /process table/);
});

test("a loop bound to a FRESH environment's bridge is live; the same loop on a STALE one is an orphan", async () => {
  const loop = [{ pid: 7, commandLine: "node" }, { pid: 41, commandLine: "node /x/hermes-managed-host.js run team.coder" }];
  const agents = { "team.coder": { runtimeState: { bridgeInstanceId: "env-bridge" } } };
  const fresh = await orphanRun({ rows: loop, agents, bridges: [], environments: [{ bridgeId: "env-bridge", spawnClaim: { state: "fresh" } }] });
  assert.equal(fresh[2], "ok", fresh[3]);
  const stale = await orphanRun({ rows: loop, agents, bridges: [{ id: "someone-else" }], environments: [{ bridgeId: "env-bridge", spawnClaim: { state: "stale" } }] });
  assert.equal(stale[2], "orphaned", stale[3]);
  assert.match(stale[3], /team\.coder \(pid 41/);
});

test("the host is not listed when there is nothing to compare it against", async () => {
  // A whole-host enumeration is a PowerShell CIM query. With the service silent, or no bridge live, the
  // verdict is unknown whatever the table holds, so the table is not read -- and not claimed unreadable.
  for (const [what, deps] of [
    ["a silent service", { reads: readsOf(async () => null) }],
    ["no live bridge", { reads: readsOf(fleet({ bridges: [] })) }],
  ]) {
    const added = [];
    let listed = 0;
    await checkManagedOrphans({ ...deps, add: (...args) => added.push(args), listProcesses: () => { listed += 1; return []; }, selfPid: 7, now: () => NOW });
    assert.equal(listed, 0, `the host was listed with ${what}`);
    assert.equal(added[0][2], "unknown-all");
    assert.doesNotMatch(added[0][3], /process table/, `an unread table was called unreadable with ${what}`);
  }
  // CONTROL: with something to compare against, it IS listed.
  let listed = 0;
  await checkManagedOrphans({
    reads: readsOf(fleet({ bridges: [{ id: LIVE_BRIDGE }] })), add: () => {},
    listProcesses: () => { listed += 1; return [{ pid: 7, commandLine: "node" }]; }, selfPid: 7, now: () => NOW,
  });
  assert.equal(listed, 1);
});

test("a claimer stamp is judged on the service's word first, then on its age", () => {
  assert.equal(envCanClaimASpawnAt({ spawnClaim: { state: "fresh" }, metadata: { bridgeLastSeen: "2000-01-01T00:00:00Z" } }, NOW), true);
  assert.equal(envCanClaimASpawnAt({ metadata: { bridgeLastSeen: new Date(NOW - 30_000).toISOString() } }, NOW), true);
  assert.equal(envCanClaimASpawnAt({ metadata: { bridgeLastSeen: new Date(NOW - 300_000).toISOString() } }, NOW), false);
  assert.equal(envCanClaimASpawnAt({ metadata: { bridgeLastSeen: "garbage" } }, NOW), false);
  assert.equal(envCanClaimASpawnAt({}, NOW), false);
});

test("a delivery loop is recognised by its script AND its run subcommand", () => {
  assert.equal(cmdlineDeliveryLoopAgent("nohup node C:/a/hermes-managed-host.js run team.coder"), "team.coder");
  assert.equal(cmdlineDeliveryLoopAgent("node hermes-managed-host.js ensure-host x"), null);
  assert.equal(cmdlineDeliveryLoopAgent(""), null);
});

// ── the environment report appends them, for the doctor only ───────────────────────────────────────

const quiet = {
  endpoint: "http://127.0.0.1:1",
  knock: async () => ({ ok: false, error: "ECONNREFUSED" }),
  readRegistry: () => ({ text: JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://127.0.0.1:2" } } }) }),
  terminalSupport: () => ({ ok: true }),
  readCredentialStore: async () => ({ names: [] }),
};

test("the doctor's report ends with the host rows, given the registry's services and the endpoint", async () => {
  let given = null;
  const checks = await collectEnvironmentChecks({
    ...quiet,
    hostChecks: async (input) => { given = input; return [{ id: "host-row", state: "passed", detail: "", fix: "" }]; },
  });
  assert.equal(checks.at(-1).id, "host-row");
  assert.deepEqual(given.services.map((service) => service.name), ["aify-comms"]);
  assert.equal(given.endpoint, "http://127.0.0.1:1");
});

test("the view, which passes no hostChecks, gets none", async () => {
  const checks = await collectEnvironmentChecks(quiet);
  assert.ok(!checks.some((check) => ["env-processes", "context-window", "managed-orphans", "claude-login"].includes(check.id)));
});

// ── code-current answers what env-code-currency asked, with its codes ────────────────────────────────

test("code-current carries env-code-currency's codes", () => {
  assert.equal(codeCurrentCheck({ answered: true, build: "a", codeOnDisk: "a" }).code, "current");
  assert.equal(codeCurrentCheck({ answered: true, build: "a", codeOnDisk: "b" }).code, "stale");
  assert.equal(codeCurrentCheck({ answered: true, build: "a" }).code, "unknown");
  assert.equal(codeCurrentCheck({ answered: false }).code, "unknown");
});

// ── the process listing: throws rather than answering empty ────────────────────────────────────────

test("a listing that failed or printed nothing throws; a real one parses", () => {
  assert.throws(() => listHostProcesses({ platform: "linux", run: () => ({ status: 1, stdout: "" }) }), /process listing failed/);
  assert.throws(() => listHostProcesses({ platform: "win32", run: () => ({ status: 0, stdout: "  " }) }), /process listing failed/);
  assert.deepEqual(listHostProcesses({ platform: "linux", run: () => ({ status: 0, stdout: "  12   1 node a b\n" }) }),
    [{ pid: 12, ppid: 1, commandLine: "node a b" }]);
  assert.deepEqual(parseWindowsListing("12\t1\tnode\ta\r\nbad\n"), [{ pid: 12, ppid: 1, commandLine: "node\ta" }]);
  assert.deepEqual(parsePosixListing("garbage"), []);
});
