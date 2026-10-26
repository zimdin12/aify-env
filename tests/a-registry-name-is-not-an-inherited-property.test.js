// A registry name is looked up as a name, never as a property the lookup table inherits.
//
// THE REVIEW CASE (b7fad9c, P2). `services.json` is a shared file anything on the host can write, and
// `readServices` keeps whatever names it holds. The doctor's plugin table was a plain object, so a
// service registered as `constructor` was handed `Object` as its doctor contributor; the doctor called
// it, failed to spread what came back, and the rejection escaped before either rendering ran -- the
// whole report lost. The same lookup chose the DAEMON's plugin factories, and the CLI's subcommands.
//
// Driven through the real paths: the registry lookups, the collector the doctor calls, the environment
// report around it, the doctor process itself, and the `aify-env` dispatcher.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { collectHostChecks, contributedRows } from "../lib/host-checks.mjs";
import { ModelReader } from "../lib/actual-model.mjs";
import { callableFor, doctorChecksFor, pluginsForServices } from "../lib/plugins/index.mjs";
import { commsDoctorChecks } from "../lib/plugins/aify-comms/doctor-checks.mjs";
import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";
import { ownHome, sealedDoctorEnv } from "./_sealed-doctor-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOWHERE = "http://127.0.0.2:1";
const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty"];

/** A registry text naming the inherited names beside an unknown service and the real aify-comms. */
const REGISTRY = `{"version":1,"services":{${[...INHERITED, "aify-unknown", "aify-comms"]
  .map((name) => `"${name}":{"endpoint":"${NOWHERE}","mcp":[]}`).join(",")}}}`;

test("CONTROL: the registry text really carries the inherited names as services", () => {
  // `__proto__` written by JSON.parse is an own key; written by an object literal it would not be.
  assert.deepEqual(Object.keys(JSON.parse(REGISTRY).services).sort(),
    [...INHERITED, "aify-unknown", "aify-comms"].sort());
});

test("an inherited name has no doctor contributor and no plugin factory", () => {
  for (const name of [...INHERITED, "aify-unknown"]) {
    assert.equal(doctorChecksFor(name), null, `${name} resolved to a contributor`);
  }
  assert.equal(doctorChecksFor("aify-comms"), commsDoctorChecks, "the real contributor is still found");
  const { plugins, unserved } = pluginsForServices(
    [...INHERITED, "aify-comms"].map((name) => ({ name, endpoint: NOWHERE })),
    { version: "test" },
  );
  assert.equal(plugins.length, 1, "a plugin was built for an inherited name");
  assert.deepEqual(unserved.sort(), [...INHERITED].sort());
});

test("an entry that is not a function is no contributor, at the lookup and at the collector", async () => {
  const table = new Map([["aify-odd", { not: "callable" }], ["aify-real", async () => []]]);
  assert.equal(callableFor(table, "aify-odd"), null);
  assert.equal(typeof callableFor(table, "aify-real"), "function");
  const rows = await collectHostChecks({
    services: [{ name: "aify-odd", endpoint: NOWHERE }], endpoint: NOWHERE, knock: async () => ({}), machineId: "m",
    listProcesses: () => [], gatewayRecords: () => [], credentialFor: async () => "", claudeLogin: () => ({ id: "claude-login" }),
    doctorChecksFor: () => ({ not: "callable" }),
  });
  assert.deepEqual(rows.map((row) => row.id), ["claude-login", "gateway-orphans"]);
});

test("THE COLLECTOR: the report renders, aify-comms contributes, an inherited name contributes nothing", async () => {
  const checks = await collectEnvironmentChecks({
    endpoint: NOWHERE,
    knock: async () => ({ ok: false, error: "ECONNREFUSED" }),
    readRegistry: () => ({ text: REGISTRY }),
    terminalSupport: () => ({ ok: true }),
    readCredentialStore: async () => ({ names: [] }),
    hostChecks: ({ services, endpoint }) => collectHostChecks({
      services,
      endpoint,
      knock: async () => ({ ok: false, error: "ECONNREFUSED" }),
      machineId: "test:host",
      listProcesses: () => assert.fail("the host was listed for a silent service"), gatewayRecords: () => [],
      credentialFor: async () => "",
      claudeLogin: () => ({ id: "claude-login", state: "passed", detail: "", fix: "", code: "skipped" }),
    }),
  });
  const ids = checks.map((check) => check.id);
  for (const id of ["env-processes", "context-window", "managed-orphans", "claude-login"]) {
    assert.ok(ids.includes(id), `${id} is missing from the report`);
  }
  assert.ok(!ids.some((id) => id.endsWith(" host checks")), `a fault row appeared: ${ids.join(", ")}`);
  assert.equal(ids.filter((id) => ["env-processes", "context-window", "managed-orphans"].includes(id)).length, 3,
    "rows were contributed more than once");
});

test("a contributor that throws or answers no list costs its own rows, and the rest still render", async () => {
  for (const [what, contributor] of [
    ["throws", async () => { throw new Error("boom"); }],
    ["answers an object", async () => ({ id: "x" })],
    ["answers a non-row", async () => [{ nope: true }]],
  ]) {
    const rows = await collectHostChecks({
      services: [{ name: "aify-broken", endpoint: NOWHERE }, { name: "aify-fine", endpoint: NOWHERE }],
      endpoint: NOWHERE, knock: async () => ({}), machineId: "m", listProcesses: () => [], gatewayRecords: () => [], credentialFor: async () => "",
      claudeLogin: () => ({ id: "claude-login", state: "passed", detail: "", fix: "" }),
      doctorChecksFor: (name) => (name === "aify-broken" ? contributor
        : async () => [{ id: "fine-row", state: "passed", detail: "", fix: "" }]),
    });
    assert.deepEqual(rows.map((row) => row.id), ["aify-broken host checks", "fine-row", "claude-login", "gateway-orphans"], what);
    assert.equal(rows[0].state, "failed", what);
    assert.match(rows[0].detail, /aify-broken/, what);
    assert.ok(rows[0].fix, what);
  }
  assert.deepEqual(await contributedRows({ name: "s" }, async () => [{ id: "r", state: "unanswered", detail: "d", fix: "" }]),
    [{ id: "r", state: "unanswered", detail: "d", fix: "" }], "a good answer passes through unchanged");
});

test("THE DOCTOR PROCESS renders the whole report for that registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-inherited-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, REGISTRY);
  const res = spawnSync(process.execPath, [path.join(HERE, "..", "bin", "aify-env-doctor.mjs"), "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: sealedDoctorEnv({ AIFY_SERVICE_REGISTRY: registry, AIFY_ENV_ENDPOINT: NOWHERE, AIFY_PROBE_TIMEOUT_MS: "300" }),
  });
  assert.equal(res.status, 0, `the doctor did not finish: ${res.stderr}`);
  const ids = JSON.parse(res.stdout).checks.map((check) => check.id);
  for (const id of ["env-processes", "context-window", "managed-orphans", "claude-login"]) {
    assert.ok(ids.includes(id), `${id} is missing: ${ids.join(", ")}`);
  }
  assert.ok(!ids.some((id) => id.endsWith(" host checks")), `a fault row appeared: ${ids.join(", ")}`);
});

test("THE DISPATCHER: an inherited name is an unknown subcommand", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const res = spawnSync(process.execPath, [path.join(HERE, "..", "bin", "aify-env.mjs"), name], {
      encoding: "utf8", timeout: 30_000, env: sealedDaemonEnv({ ...ownHome() }),
    });
    assert.equal(res.status, 64, `\`aify-env ${name}\` exited ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /unknown subcommand/);
  }
});

test("THE MODEL READER: a harness named after an inherited property has no source", async () => {
  const asked = [];
  const reader = new ModelReader({ stat: () => assert.fail("a source was read"), read: async (q) => { asked.push(q.harness); return "answer"; } });
  for (const harness of ["constructor", "toString"]) {
    assert.equal(await reader.read({ harness, workspace: "/w", handle: "h" }), "answer");
  }
  assert.deepEqual(asked, ["constructor", "toString"]);
});
