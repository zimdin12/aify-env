// A defined worker's secret reaches that worker's environment and nowhere else (aify-dashboard
// docs/DESIGN-SECRETS-INJECTION.md, rule 7, test 1, and gap 4 of its review).
//
// THE REAL PATH. The aify-dashboard plugin and the aify-comms plugin, started through a real ServicePlugins the way the
// daemon starts them, a real DefinitionStore, a real Runner starting a real bash launcher in a real terminal, and a
// real HTTP listener standing in for the dashboard. aify-comms is a recording fake `api`: everything the host would
// send it is an argument to one of its calls, and every argument is kept.
//
// THE WORKER PRINTS NOTHING, so a byte of the value in its output stream or the Runner's replay is a defect, not the
// documented limit (a worker that echoes its env publishes it; that is environment injection's limit, not tested here).
//
// IT TOUCHES NOTHING THE OPERATOR OWNS: temp directories, an ephemeral loopback port, a launcher written for the test.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";
import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { Runner, terminalSupport } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const slashed = (p) => p.replace(/\\/g, "/");
const noTerminal = !terminalSupport().available && "this host has no terminal support, so no real worker can start";

/** Every form a value could be written in that a plain search would miss. PURE. */
const formsOf = (value) => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"), JSON.stringify(value).slice(1, -1)];

/** The labels of the places that hold any form of `value`. PURE. */
function holding(places, value) {
  const forms = formsOf(value);
  return places.filter(([, content]) => forms.some((form) => String(content).includes(form))).map(([label]) => label);
}

/** Every file under `dir`, as [path, text], except those `skip` names. */
function filesUnder(dir, skip) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skip.has(full)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(full, skip));
    else out.push([slashed(full), fs.readFileSync(full, "latin1")]);
  }
  return out;
}

async function until(condition, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A dashboard serving `value` for every secret, recording every request with its body. */
async function fakeDashboard(t, value) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.stringify({ method: request.method, url: request.url, headers: request.headers, body }));
      const match = /^\/api\/v1\/projects\/[^/]+\/secrets\/([^/]+)\/value$/.exec(request.url ?? "");
      response.writeHead(match ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(match ? { name: decodeURIComponent(match[1]), value } : { error: "no such route", code: "not_found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests };
}

/**
 * Start one defined worker, whose definition names OPENAI_API_KEY, through both plugins, with the dashboard serving
 * `value`. The launcher writes what bash sees, and what a child bash execs sees, to two files and prints nothing.
 */
async function startDefinedWorker(t, value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sentinel-"));
  const storeDir = path.join(root, "definitions");
  const out = path.join(root, "worker-saw");
  const launcher = path.join(root, "claude-aify");
  // The child writes what it saw, then holds until released, so the host's records of a RUNNING worker can be read.
  const childScript = 'const fs = require("fs"); const out = process.env.SECRET_OUT; fs.writeFileSync(out + ".child", process.env.OPENAI_API_KEY ?? "");'
    + ' const held = setInterval(() => { if (fs.existsSync(out + ".release")) clearInterval(held); }, 20);';
  fs.writeFileSync(launcher, ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"',
    'printf "%s" "$OPENAI_API_KEY" > "$SECRET_OUT.bash"',
    `exec "$NODE_FOR_TEST" -e '${childScript}'`, ""].join("\n"));

  const store = new DefinitionStore({ dir: storeDir, lockWaitMs: 2000 });
  await store.set("lead", { name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: slashed(root),
    model: "", effort: "", instructions: "", env: {}, herdrSpace: false,
    secrets: { project: "p1", names: ["OPENAI_API_KEY"] } }, { installed: ALL });
  const { storeId } = await store.list();

  const dashboard = await fakeDashboard(t, value);
  const sent = [];
  let handedOut = false;
  const record = (call) => async (...args) => { sent.push(JSON.stringify([call, ...args])); return {}; };
  const api = {
    identity: { bridgeId: "bridge-test" },
    heartbeat: record("heartbeat"), claim: record("claim"),
    async claimControls(...args) {
      sent.push(JSON.stringify(["claimControls", ...args]));
      if (handedOut) return { controls: [] };
      handedOut = true;
      return { controls: [{ id: "ctl-1", terminalId: "term-1", action: "start", cols: 80, rows: 24 }] };
    },
    async launch(...args) {
      sent.push(JSON.stringify(["launch", ...args]));
      return { launch: { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: [slashed(launcher), "--aify-agent", "lead"],
        cwd: slashed(root), env: { SECRET_OUT: slashed(out), NODE_FOR_TEST: slashed(process.execPath) },
        definition: { storeId, incarnation: 1, revision: 1 } } };
    },
    reportControl: record("reportControl"), terminalOutput: record("terminalOutput"),
    async claimDefinitionRequests(...args) { sent.push(JSON.stringify(["claimDefinitionRequests", ...args])); return { requests: [] }; },
    async pushDefinitions(...args) { sent.push(JSON.stringify(["pushDefinitions", ...args])); return { ok: true, refused: [] }; },
  };

  const ownedFile = path.join(root, "env-processes.json");
  const runner = new Runner({ ownedFile });
  const registry = new ServicePlugins();
  const logs = [];
  const host = new PluginHost({ processes: new PluginProcesses(runner), environmentId: "", log: (line) => logs.push(line),
    credential: async (service, field) => (field === "secretsCredentialRef" ? "fetch-key-for-the-secrets-route-01" : "api-key-for-the-test-only-0123"),
    spawnEnv: () => registry.capabilities("spawnEnv") });
  t.after(async () => {
    await registry.stopAll();
    for (const { id } of runner.list()) await runner.stop(id).catch(() => {});
  });
  // A dedicated instance's dashboard plugin: it offers the contributor and reports no heads, so the dashboard sees
  // only the fetch. An ordinary one offers the same (the-dashboard-plugin-fetches-a-workers-secrets.test.js).
  await registry.add(createDashboardPlugin({ endpoint: dashboard.endpoint, dedicated: true, service: { name: "aify-dashboard", endpoint: dashboard.endpoint } }), host);
  const comms = createCommsPlugin({ endpoint: "http://127.0.0.1:1", machineId: "win32:test-host", windows: process.platform === "win32", api,
    advertisement: async () => ({ hostname: "test-host", kind: "test" }), cwdRoots: async () => [slashed(root)],
    definitions: store, installedHarnesses: async () => ALL, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} });
  await registry.add(comms, host);

  await until(() => sent.some((s) => s.startsWith('["reportControl"')), "the start to be reported");
  await until(() => fs.existsSync(`${out}.child`), "the worker to write what it saw");
  const reported = JSON.parse(sent.find((s) => s.startsWith('["reportControl"')));
  const handle = String(reported[2]?.handle ?? "");
  // What the host keeps about a running worker: its owned-process record holds the worker only until it exits.
  const whileRunning = { owned: fs.readFileSync(ownedFile, "latin1"), registry: JSON.stringify(runner.list()), health: JSON.stringify(registry.report()) };
  fs.writeFileSync(`${out}.release`, "");
  await until(() => !runner.list().some((p) => p.id === handle), "the worker to exit");
  return { root, out, runner, registry, logs, sent, dashboard, storeDir, handle, whileRunning };
}

test("THE SENTINEL reaches the worker's env, and no byte of it is anywhere else", { skip: noTerminal, timeout: 60_000 }, async (t) => {
  // The bug: a secret's value written anywhere but the worker's env: a log line, /health, the process registry or its
  // file, a definition file, its trash or receipts, anything sent to either service, the output stream, the replay.
  const SENTINEL = `sentinel-${randomBytes(12).toString("hex")}`;
  const run = await startDefinedWorker(t, SENTINEL);
  const report = run.sent.find((s) => s.startsWith('["reportControl"'));
  assert.doesNotMatch(report, /failed/, `the start was refused: ${report}`);

  // POSITIVE CONTROLS, in the same run: the worker saw the value in bash and in the process bash exec'd, and the
  // instrument finds a planted copy in each form it searches.
  assert.equal(fs.readFileSync(`${run.out}.bash`, "utf8"), SENTINEL, "bash saw the value");
  assert.equal(fs.readFileSync(`${run.out}.child`, "utf8"), SENTINEL, "and so did its child");
  for (const form of formsOf(SENTINEL)) assert.deepEqual(holding([["planted", `x${form}y`]], SENTINEL), ["planted"], form);

  // THE REPLAY, as a console attaching late is handed it: the stream outlives the exited process.
  const [worker] = run.runner.list().length ? run.runner.list() : [{ id: run.handle }];
  const replay = [];
  const unsubscribe = run.runner.subscribe(run.handle || worker.id, (chunk) => replay.push(String(chunk)));
  assert.ok(unsubscribe, "the worker's stream is still held, so its replay is read");
  unsubscribe();
  const places = [
    ...run.logs.map((line, i) => [`log line ${i}`, line]),
    ["/health plugins", JSON.stringify(run.registry.report())],
    ["the runner's registry", JSON.stringify(run.runner.list())],
    ["the runner's history", JSON.stringify(run.runner.history())],
    ["env-processes.json while the worker ran", run.whileRunning.owned],
    ["the runner's registry while the worker ran", run.whileRunning.registry],
    ["/health plugins while the worker ran", run.whileRunning.health],
    ["the runner's replay", replay.join("")],
    ...run.sent.map((call, i) => [`sent to aify-comms ${i}`, call]),
    ...run.dashboard.requests.map((request, i) => [`sent to aify-dashboard ${i}`, request]),
    ...filesUnder(run.root, new Set([`${run.out}.bash`, `${run.out}.child`])),
  ];
  assert.ok(places.some(([label]) => label.endsWith("env-processes.json")), "the runner's file was written, so it is searched");
  assert.ok(run.whileRunning.owned.includes(run.handle), "and while the worker ran it held the worker's entry");
  assert.ok(places.some(([label]) => label.includes("/definitions/")), "the definition store's files are searched");
  const found = holding(places, SENTINEL);
  assert.deepEqual(found, [], `no byte of the value outside the worker's env; found in: ${found.join(", ")}`);
});

test("MEASURED: a value holding CR, LF and both arrives intact, in bash and in what bash execs", { skip: noTerminal, timeout: 60_000 }, async (t) => {
  // Gap 3: a launcher is a bash script, and a value with a line ending in it might arrive changed rather than refused.
  // The review: keep it if it arrives intact, refuse it with that reason if not. This is that measurement, through the
  // real path, with the bytes compared exactly; a tab and a trailing CR are in it too.
  const value = `first\r\nsecond\rthird\nfourth\tfifth\r`;
  const run = await startDefinedWorker(t, value);
  assert.equal(Buffer.from(fs.readFileSync(`${run.out}.bash`)).toString("hex"), Buffer.from(value).toString("hex"), "bash");
  assert.equal(Buffer.from(fs.readFileSync(`${run.out}.child`)).toString("hex"), Buffer.from(value).toString("hex"), "the child");
});
