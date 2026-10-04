#!/usr/bin/env node
// The aify-dashboard contributor's failures reach the host as a reason from its list and the secret's name, nothing
// more; and a completion after the plugin stopped is refused (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, "The
// dashboard contributor: plan revision 1").
//
// AT THE CONSUMER. The real plugin and DashboardApi over a fake dashboard fetch, offered through a real ServicePlugins;
// the real runOneControl, PluginProcesses over a fake runner, and a real CommsApi over a fake fetch that keeps every
// request; the host's log lines. Every failure carries a sentinel in what the dashboard side controls.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { CommsApi } from "../lib/plugins/aify-comms/api.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const S = `sentinel${randomBytes(8).toString("hex")}`;
const LEAD = { name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/work", model: "", effort: "",
  instructions: "", env: {}, herdrSpace: true, secrets: { project: "p1", names: ["OPENAI_API_KEY"] } };
const json = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const said = (reason) => `a plugin: OPENAI_API_KEY ${reason}`;

/** The plugin started on a host whose secrets credential is `fetchKey()`, with a dashboard answering `answer`. */
async function dashboardPlugin(t, answer, { fetchKey = async () => "fetch-key-for-the-secrets-route-01" } = {}) {
  const asked = [];
  const fetch = async (url, init) => { asked.push(url); return answer(url, init); };
  const runner = { starts: [], async start(spec) { this.starts.push(spec); return { id: "proc-1", pid: 1 }; }, subscribe() { return () => {}; }, list() { return []; } };
  const host = new PluginHost({ processes: new PluginProcesses(runner),
    credential: async (service, field) => (field === "secretsCredentialRef" ? fetchKey() : "api-key-for-every-agent-0123456789") });
  const plugin = createDashboardPlugin({ endpoint: "http://dashboard.invalid", dedicated: true, service: { name: "aify-dashboard" } }, { fetch });
  const registry = new ServicePlugins();
  t.after(() => registry.stopAll());
  await registry.add(plugin, host);
  return { plugin, host, registry, asked, runner };
}

/** One defined start through the real control path, asking `contributors()`. */
async function start(contributors, runner) {
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-contrib-fail-")), lockWaitMs: 300 });
  await store.set("lead", LEAD, { installed: ALL });
  const { storeId } = await store.list();
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: ["claude-aify"], cwd: "C:/work", env: {},
    definition: { storeId, incarnation: 1, revision: 1 } };
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    sent.push(JSON.stringify({ url, method: init.method, body: init.body ?? "" }));
    return url.endsWith("/terminals/term-1/launch") ? json(200, { launch }) : json(200, { ok: true });
  };
  const logs = [];
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, handles: createHandleBook(), log: (line) => logs.push(line),
    api: new CommsApi({ endpoint: "http://comms.invalid", credential: async () => "k", identity: { bridgeId: "b" }, fetchImpl }),
    processes: new PluginProcesses(runner), cwdRoots: ["C:/work"], windows: true, withinRoots: workspaceWithinRoots, baseEnv: {},
    buildSpec: ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } }),
    resolveCandidates: () => ["C:/bin/claude-aify"],
    admitStart: (l, produce) => store.admitStart(l, produce), definitionFor: (l) => store.boundReading(l),
    spawnEnv: contributors,
  });
  return { result, sent, logs };
}

function refusedQuietly(run, runner, reason) {
  assert.equal(run.result.outcome, "refused", JSON.stringify(run.result));
  assert.equal(run.result.detail, reason);
  assert.equal(runner.starts.length, 0, "nothing started");
  assert.ok(![...run.sent, ...run.logs].some((text) => text.includes(S)), "the sentinel is in no request to comms and no log line");
}

const valid = () => json(200, { name: "OPENAI_API_KEY", value: S });
const prose = (code) => ({ error: `the dashboard's prose holds ${S}`, code });

test("HEALTHY, on the same path: the value reaches the spec and nothing else", async (t) => {
  const { registry, runner } = await dashboardPlugin(t, valid);
  const run = await start(() => registry.capabilities("spawnEnv"), runner);
  assert.equal(run.result.outcome, "started", JSON.stringify(run.result));
  assert.equal(runner.starts[0].env.OPENAI_API_KEY, S);
  assert.ok(![...run.sent, ...run.logs].some((text) => text.includes(S)));
});

for (const [what, answer, reason, options] of [
  ["a transport exception holding the sentinel", () => { throw new Error(S); }, said("could not be fetched")],
  ["the dashboard's prose holding it", () => json(404, prose("no_such_secret")), said("was not found where it is kept")],
  ["a string code holding it", () => json(404, prose(S)), said("was refused where it is kept")],
  ["a code that is an array", () => json(404, prose(["no_such_secret"])), said("was refused where it is kept")],
  ["a code that is a number", () => json(404, prose(404)), said("was refused where it is kept")],
  ["a known code under another status", () => json(500, prose("no_such_secret")), said("was refused where it is kept")],
  ["a body that cannot be read", () => ({ ok: true, status: 200, text: async () => { throw new Error(S); } }), said("could not be fetched")],
  ["a malformed success", () => json(200, { name: "OTHER", value: S }), said("came back malformed")],
  ["no fetch credential", valid, said("could not be fetched: this host holds no credential for it"), { fetchKey: async () => "" }],
  ["a credential resolver that throws it", valid, said("could not be fetched"), { fetchKey: async () => { throw new Error(S); } }],
]) {
  test(`FAILURE: ${what} refuses in the host's words and leaves nothing of it`, async (t) => {
    const { registry, runner, asked } = await dashboardPlugin(t, answer, options);
    refusedQuietly(await start(() => registry.capabilities("spawnEnv"), runner), runner, reason);
    if (options?.fetchKey) assert.equal(asked.length, 0, "no key, no request to the dashboard");
  });
}

/** A dashboard answer held until `release()`, which ignores the abort unless `cooperative`. */
function held({ cooperative = false } = {}) {
  let release;
  let began;
  const reached = new Promise((resolve) => { began = resolve; });
  const answer = (url, init) => {
    began();
    return new Promise((resolve, reject) => {
      release = () => resolve(valid());
      if (cooperative) init.signal.addEventListener("abort", () => reject(new Error(`aborted ${S}`)), { once: true });
    });
  };
  return { answer, reached, release: () => release() };
}

test("STOP: a body that ignores the abort and completes after stop with a valid value is refused, and starts nothing", async (t) => {
  const body = held();
  const { plugin, registry, runner } = await dashboardPlugin(t, body.answer);
  const offers = registry.capabilities("spawnEnv");
  const pending = start(() => offers, runner);
  await body.reached;
  await plugin.stop();
  body.release();
  refusedQuietly(await pending, runner, said("could not be fetched"));
});

test("STOP, cooperative control: a fetch that honours the abort is refused the same way", async (t) => {
  const body = held({ cooperative: true });
  const { plugin, registry, runner } = await dashboardPlugin(t, body.answer);
  const offers = registry.capabilities("spawnEnv");
  const pending = start(() => offers, runner);
  await body.reached;
  await plugin.stop();
  refusedQuietly(await pending, runner, said("could not be fetched"));
});

test("STOP: a contributor captured before stop and asked after it is unavailable, and asks the dashboard nothing", async (t) => {
  const { plugin, registry, runner, asked } = await dashboardPlugin(t, valid);
  const captured = registry.capabilities("spawnEnv");
  await plugin.stop();
  refusedQuietly(await start(() => captured, runner), runner, "a plugin: a variable it supplies cannot be fetched on this host now");
  assert.equal(asked.length, 0);
});

test("RESTART: an old call released after the plugin restarted is refused, and a new call starts", async (t) => {
  const body = held();
  let current = body.answer;
  const { plugin, host, registry, runner } = await dashboardPlugin(t, (url, init) => current(url, init));
  const offers = registry.capabilities("spawnEnv");
  const old = start(() => offers, runner);
  await body.reached;
  await plugin.stop();
  await plugin.start(host);
  current = valid;
  body.release();
  refusedQuietly(await old, runner, said("could not be fetched"));
  const fresh = await start(() => offers, runner);
  assert.equal(fresh.result.outcome, "started", JSON.stringify(fresh.result));
  assert.equal(runner.starts[0].env.OPENAI_API_KEY, S);
});

test("an ask whose host signal is already aborted makes no request at all", async (t) => {
  // The check before each request: without it the request is made and fails, which the outcome alone cannot show.
  const { registry, asked } = await dashboardPlugin(t, valid);
  const [offered] = registry.capabilities("spawnEnv");
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await offered.contribute({ definition: LEAD, signal: aborted.signal }), { refused: { reason: "unreachable", variable: "OPENAI_API_KEY" } });
  assert.equal(asked.length, 0);
});
