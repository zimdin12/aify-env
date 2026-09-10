import test from "node:test";
import assert from "node:assert/strict";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { summarise } from "../lib/health.mjs";
import { pickerReadinessCheck } from "../lib/environment-checks.mjs";
import { CommsApi } from "../lib/plugins/aify-comms/api.mjs";
import { AgentStarter } from "../lib/plugins/aify-comms/agent-starter.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const endpoint = "http://example.invalid";
const healthy = { ok: true, status: 200, body: {
  processes: [], terminals: { available: true }, advertiseCredentials: {},
  plugins: [{ name: "test", state: { claimer: { accepted: true } } }],
  build: "abc", codeOnDisk: "abc",
} };
async function report(answer, envAnswer = healthy) {
  const urls = [];
  const checks = await collectEnvironmentChecks({
    endpoint,
    knock: async (url) => {
      urls.push(url);
      if (url === `${endpoint}/health`) return envAnswer;
      assert.equal(url, `${endpoint}/agents/startable`, "readiness may only GET the read-only picker route");
      return typeof answer === "function" ? answer() : answer;
    },
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const check = checks.find((c) => c.id === "agent-picker");
  assert.ok(check, "doctor omitted functional picker readiness");
  return { check, checks, urls, result: summarise(checks) };
}

// Replace only owned transport. Decode real Responses and retain the production
// API -> starter -> route -> collector path, including the route's JSON boundary.
async function rosterReport(text, status = 200, transportError = false) {
  const requests = [];
  const api = new CommsApi({ endpoint, credential: async () => "",
    identity: { bridgeId: "picker-test-only" },
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      assert.equal(url, `${endpoint}/api/v1/agents`);
      assert.equal(options.method, "GET");
      if (transportError) throw new Error("owned transport unavailable");
      return new Response(text, { status });
    },
  });
  const starter = new AgentStarter({ api, machineId: "win32:picker-test-only" });
  const result = await report(async () => {
    const answer = await handleRequest({ method: "GET", path: "/agents/startable" }, { agents: starter });
    return { ok: true, status: answer.status, body: JSON.parse(JSON.stringify(answer.body)) };
  });
  assert.deepEqual(requests, [{ url: `${endpoint}/api/v1/agents`, method: "GET" }]);
  return result;
}

test("real roster pipeline accepts valid empty data with every doctor row green", async () => {
  const { checks, result } = await rosterReport('{"agents":{}}');
  assert.ok(checks.length > 0);
  for (const check of checks) assert.equal(check.state, "passed", check.id);
  assert.equal(result.exitCode, 0);
});

for (const [name, text, status, transportError] of [
  ["invalid JSON", "not JSON", 200],
  ["null body", "null", 200],
  ["missing roster", "{}", 200],
  ["null roster", '{"agents":null}', 200],
  ["array roster", '{"agents":[]}', 200],
  ["scalar roster", '{"agents":"invalid"}', 200],
  ["body refusal", '{"ok":false,"error":"refused","agents":{}}', 200],
  ["no-content response", null, 204],
  ["HTTP refusal", '{"error":"refused"}', 401],
  ["transport exception", null, 200, true],
]) {
  test(`real roster pipeline rejects ${name} without another doctor failure`, async () => {
    const { check, checks, result } = await rosterReport(text, status, transportError);
    for (const other of checks.filter((row) => row.id !== "agent-picker")) {
      assert.equal(other.state, "passed", other.id);
    }
    assert.equal(check.state, "failed");
    assert.ok(check.detail);
    assert.equal(result.exitCode, 1);
  });
}

test("picker readiness requires a finite HTTP status", async () => {
  for (const status of ["garbage", NaN, Infinity, -Infinity]) {
    const { check, checks, result } = await report({ ok: true, status, body: { agents: [], problem: "" } });
    for (const other of checks.filter((row) => row.id !== "agent-picker")) {
      assert.equal(other.state, "passed", other.id);
    }
    assert.equal(check.state, "unanswered", String(status));
    assert.equal(result.exitCode, 2);
  }
});

test("doctor fails readiness when a healthy daemon's picker lacks machine identity", async () => {
  const problem = "this environment cannot say which machine it is, so it cannot scope the list";
  const { check, result, urls } = await report({ ok: true, status: 200, body: { agents: [], problem } });
  assert.equal(check.state, "failed");
  assert.ok(check.detail.includes(problem));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(urls, [`${endpoint}/health`, `${endpoint}/agents/startable`]);
});

test("an empty but working picker passes readiness", async () => {
  const { check, checks, result } = await report({ ok: true, status: 200, body: { agents: [], problem: "" } });
  assert.equal(check.state, "passed");
  for (const row of checks) assert.equal(row.state, "passed", row.id);
  assert.equal(result.exitCode, 0);
});

test("missing plugin and refused picker replies fail readiness", async () => {
  for (const status of [503, 401, 500]) {
    const { check } = await report({ ok: true, status, body: { agents: [], problem: "picker unavailable" } });
    assert.equal(check.state, "failed", `HTTP ${status} must not pass`);
  }
});

test("unreachable or malformed picker evidence never passes", async () => {
  for (const answer of [
    { ok: false, error: "timed out" },
    { ok: true, status: 200, body: null },
    { ok: true, status: 200, body: {} },
    { ok: true, status: 200, body: { agents: [] } },
    { ok: true, status: 200, body: { agents: {}, problem: "" } },
  ]) {
    const { check } = await report(answer);
    assert.equal(check.state, "unanswered");
  }
});

test("pickerReadinessCheck leaves the evidence unchanged", () => {
  const answer = Object.freeze({ ok: true, status: 200,
    body: Object.freeze({ agents: Object.freeze([]), problem: "" }) });
  const before = JSON.stringify(answer);
  assert.equal(pickerReadinessCheck(answer).state, "passed");
  assert.equal(JSON.stringify(answer), before);
});

test("doctor does not query a picker when no environment answered", async () => {
  const { check, urls } = await report(null, { ok: false, error: "refused" });
  assert.equal(check.state, "unanswered");
  assert.deepEqual(urls, [`${endpoint}/health`]);
});
