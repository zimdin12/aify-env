// The aify-dashboard plugin's `spawnEnv` contributor: the secrets a defined worker's definition names, fetched from
// the dashboard at start, one GET each (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, B to E). A real listener
// stands in for the dashboard and records every request, headers included.
//
// THE CONFOUNDER IS ALWAYS PRESENT: every refusal the fake dashboard sends carries the sentinel value in its prose, so a
// reason that repeated the dashboard's words would carry it, and "no value in the reason" can fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { Runner } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";

const SENTINEL = "sentinel-7f3a91c2-value";
const API_KEY = "api-key-for-every-agent-0123456789";
const FETCH_KEY = "fetch-key-for-the-secrets-route-01";
const SECRETS = { project: "p1", names: ["OPENAI_API_KEY", "STRIPE_KEY"] };
const definition = (secrets = SECRETS) => ({ name: "Lead", env: {}, ...(secrets ? { secrets } : {}) });
const VALUE = /^\/api\/v1\/projects\/([^/]+)\/secrets\/([^/]+)\/value$/;

/** A dashboard answering each secret's value as `answers[name]` says (default: the sentinel), recording requests. */
async function fakeDashboard(t, answers = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const value = VALUE.exec(request.url ?? "");
    if (!value) return send(404, { error: `no such route; ${SENTINEL}`, code: "not_found" });
    const name = decodeURIComponent(value[2]);
    const answer = answers[name] ?? { status: 200, body: { name, value: `${SENTINEL}-${name}` } };
    if (answer.hang) return; // never answers
    send(answer.status, answer.body, answer.headers);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests };
}

/** The plugin, started on a host whose credential answers by field, and its offered contributor. */
async function started(t, endpoint, { fetchKey = FETCH_KEY, dedicated = true } = {}) {
  const fields = [];
  const host = new PluginHost({ processes: new PluginProcesses(new Runner({ openTerminal: () => null })),
    credential: async (service, field) => { fields.push(field); return field === "secretsCredentialRef" ? fetchKey : API_KEY; } });
  // A herdr's dedicated instance by default: it reports no heads, so the only requests are the contributor's. It starts
  // workers, so it must offer the contributor too; the last test checks an ordinary instance offers the same.
  const plugin = createDashboardPlugin({ endpoint, dedicated, machineId: "win32:test-host", service: { name: "aify-dashboard", endpoint } },
    { tickMs: 60_000 });
  const registry = new ServicePlugins();
  t.after(() => registry.stopAll());
  await registry.add(plugin, host);
  const [offered] = registry.capabilities("spawnEnv");
  assert.ok(offered, "the started plugin offers spawnEnv");
  return { plugin, offered, fields };
}

const ask = (offered, secrets, signal = new AbortController().signal) => offered.contribute({ definition: definition(secrets), signal });
const secretRequests = (requests) => requests.filter((request) => VALUE.test(request.url));

test("a defined worker's secrets are fetched, one GET each, presenting the fetch key alone", async (t) => {
  // The bugs: a worker without its secrets; and design test 6, credentials swapped, so the fleet-wide API key is sent
  // to the route that hands out values, or the fetch key anywhere else.
  const dashboard = await fakeDashboard(t);
  const { offered, fields } = await started(t, dashboard.endpoint);
  assert.equal(offered.service, "aify-dashboard");
  assert.equal(offered.field, "secrets", "it supplies the definition's secrets");
  assert.deepEqual(await ask(offered, SECRETS),
    { env: { OPENAI_API_KEY: `${SENTINEL}-OPENAI_API_KEY`, STRIPE_KEY: `${SENTINEL}-STRIPE_KEY` } });
  const asked = secretRequests(dashboard.requests);
  assert.deepEqual(asked.map((r) => [r.method, r.url]), [
    ["GET", "/api/v1/projects/p1/secrets/OPENAI_API_KEY/value"], ["GET", "/api/v1/projects/p1/secrets/STRIPE_KEY/value"]]);
  for (const request of asked) {
    assert.equal(request.headers["x-aify-secrets-key"], FETCH_KEY);
    assert.equal(request.headers["x-api-key"], undefined, "the API key is not presented to the secrets route");
    assert.ok(!Object.values(request.headers).includes(API_KEY), "under any header");
  }
  assert.ok(fields.includes("secretsCredentialRef"), "the fetch key is the entry's own secrets credential");
});

test("a definition that names no secrets asks the dashboard nothing", async (t) => {
  // The bug (design test 3): a network call on every start. Positive control in the same run: one that names some asks.
  const dashboard = await fakeDashboard(t);
  const { offered } = await started(t, dashboard.endpoint);
  assert.deepEqual(await ask(offered, null), { env: {} });
  assert.equal(dashboard.requests.length, 0);
  await ask(offered, { project: "p1", names: ["OPENAI_API_KEY"] });
  assert.equal(dashboard.requests.length, 1, "the control: a definition naming one secret makes one request");
});

test("each failure refuses with the secret, the project and the dashboard's code, and never a value", async (t) => {
  // The bug (design D, test 2): a worker started without a secret, or a reason carrying a value. One case per failure,
  // each varying only that failure; every refusal body carries the sentinel in its prose.
  const prose = (code) => ({ error: `refused, and this prose says ${SENTINEL}`, code });
  const cases = [
    ["no such secret", { status: 404, body: prose("no_such_secret") }, /^secret OPENAI_API_KEY for project p1 was refused: 404 no_such_secret$/],
    ["no such project", { status: 404, body: prose("no_such_project") }, /was refused: 404 no_such_project$/],
    ["unreadable", { status: 409, body: prose("unreadable") }, /was refused: 409 unreadable$/],
    ["no store", { status: 503, body: prose("no_secret_store") }, /was refused: 503 no_secret_store$/],
    ["a refusal with no code", { status: 500, body: `<html>${SENTINEL}</html>` }, /was refused: 500, with no code$/],
    ["another name's value", { status: 200, body: { name: "STRIPE_KEY", value: SENTINEL } }, /^secret OPENAI_API_KEY for project p1: the answer was not that secret's value$/],
    ["a value that is not text", { status: 200, body: { name: "OPENAI_API_KEY", value: 5 } }, /the answer was not that secret's value$/],
    ["no JSON", { status: 200, body: `${SENTINEL} as plain text` }, /the answer was not that secret's value$/],
  ];
  for (const [what, answer, reason] of cases) {
    const dashboard = await fakeDashboard(t, { OPENAI_API_KEY: answer });
    const { offered } = await started(t, dashboard.endpoint);
    const result = await ask(offered, SECRETS);
    assert.deepEqual(Object.keys(result), ["refused"], what);
    assert.match(result.refused, reason, what);
    assert.ok(!result.refused.includes(SENTINEL), `${what}: no value, and none of the dashboard's prose`);
    assert.equal(secretRequests(dashboard.requests).length, 1, `${what}: the first failure stops the fetch`);
  }
});

test("a redirect is refused, and the place it points to never sees the fetch key", async (t) => {
  const elsewhere = await fakeDashboard(t);
  const dashboard = await fakeDashboard(t, { OPENAI_API_KEY: { status: 302, body: "", headers: { location: `${elsewhere.endpoint}/api/v1/projects/p1/secrets/OPENAI_API_KEY/value` } } });
  // Positive control: the target records what reaches it, key and all.
  await fetch(`${elsewhere.endpoint}/control`, { headers: { "x-aify-secrets-key": "control" } });
  assert.equal(elsewhere.requests.at(-1).headers["x-aify-secrets-key"], "control");
  elsewhere.requests.length = 0;
  const { offered } = await started(t, dashboard.endpoint);
  assert.match((await ask(offered, SECRETS)).refused, /^secret OPENAI_API_KEY for project p1 was refused: 302, with no code$/);
  assert.deepEqual(elsewhere.requests, [], "nothing reached the redirect's target");
});

test("no fetch credential, or no dashboard answering, refuses; and no credential asks nothing", async (t) => {
  const dashboard = await fakeDashboard(t);
  const { offered } = await started(t, dashboard.endpoint, { fetchKey: "" });
  assert.equal((await ask(offered, SECRETS)).refused,
    "secret OPENAI_API_KEY for project p1 could not be fetched: no secretsCredentialRef for aify-dashboard on this host");
  assert.equal(dashboard.requests.length, 0, "and the dashboard was asked nothing, under the API key or any other");
  const silent = await fakeDashboard(t);
  const { offered: unanswered } = await started(t, silent.endpoint.replace(/:\d+$/, ":1"));
  assert.match((await ask(unanswered, SECRETS)).refused, /^secret OPENAI_API_KEY for project p1 could not be fetched: aify-dashboard did not answer GET /);
});

test("the host's signal stops a fetch in flight, and so does stopping the plugin", { timeout: 10_000 }, async (t) => {
  // The bug: a fetch that outlives the start it was for. The host aborts at SPAWN_ENV_WAIT_MS; the plugin's stop at stop.
  const dashboard = await fakeDashboard(t, { OPENAI_API_KEY: { hang: true } });
  const { offered, plugin } = await started(t, dashboard.endpoint);
  const host = new AbortController();
  const began = Date.now();
  const pending = ask(offered, SECRETS, host.signal);
  setTimeout(() => host.abort(), 50);
  assert.match((await pending).refused, /could not be fetched: aify-dashboard did not answer/);
  assert.ok(Date.now() - began < 5_000, "stopped by the signal, not the 10 s request limit");
  const second = ask(offered, SECRETS);
  setTimeout(() => plugin.stop(), 50);
  assert.match((await second).refused, /could not be fetched/);
});

test("an ordinary instance offers the same contributor, and one not started refuses", async (t) => {
  const dashboard = await fakeDashboard(t);
  const { offered } = await started(t, dashboard.endpoint, { dedicated: false });
  assert.equal((await ask(offered, { project: "p1", names: ["OPENAI_API_KEY"] })).env.OPENAI_API_KEY, `${SENTINEL}-OPENAI_API_KEY`);
  const never = createDashboardPlugin({ endpoint: dashboard.endpoint, dedicated: true, service: { name: "aify-dashboard" } });
  assert.deepEqual(await never.capabilities.spawnEnv.contribute({ definition: definition(), signal: new AbortController().signal }),
    { refused: "the aify-dashboard plugin has not started" });
});
