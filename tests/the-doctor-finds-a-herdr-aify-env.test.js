// `aify-env doctor` finds a `herdr-aify env` daemon on the port the OS gave it (external review, T3).
//
// It probed only AIFY_ENV_ENDPOINT or 8802 and said "no environment is running" while a dedicated
// daemon ran on 63204. It now falls back to the daemon's own ready.json receipts, trusting one only
// when that endpoint's /health answers with the receipt's pid and instance. Offline: the receipts and
// the probes are injected.

import assert from "node:assert/strict";
import test from "node:test";

import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";
import { discoverServingEndpoint, readyReceipts, RECEIPT_LIMIT } from "../lib/serving-endpoint.mjs";

const LIVE = { endpoint: "http://127.0.0.1:63204", pid: 74832, envInstance: "inst-live", writtenMs: 3 };
const STALE = { endpoint: "http://127.0.0.1:57978", pid: 111, envInstance: "inst-old", writtenMs: 1 };
const healthOf = { "http://127.0.0.1:63204": { pid: 74832, instance: "inst-live" } };
const fetchHealth = async (endpoint) => healthOf[endpoint] ?? null;

test("the one receipt whose daemon answers with its own pid and instance is found", async () => {
  assert.equal(await discoverServingEndpoint({ receipts: [LIVE, STALE], fetchHealth }), LIVE.endpoint);
});

test("a receipt whose port now answers as someone else is not believed", async () => {
  const reused = { ...STALE, endpoint: LIVE.endpoint };
  assert.equal(await discoverServingEndpoint({ receipts: [reused], fetchHealth }), "");
});

test("two live daemons are left unresolved, not guessed between", async () => {
  const other = { endpoint: "http://127.0.0.1:60000", pid: 2, envInstance: "i2", writtenMs: 2 };
  const both = async (e) => (e === other.endpoint ? { pid: 2, instance: "i2" } : fetchHealth(e));
  assert.equal(await discoverServingEndpoint({ receipts: [LIVE, other], fetchHealth: both }), "");
});

test("only the newest receipts are probed, so stale ones cannot make the doctor wait", async () => {
  const probed = [];
  const many = Array.from({ length: 20 }, (_, i) => ({ ...STALE, endpoint: `http://127.0.0.1:${50000 + i}` }));
  await discoverServingEndpoint({ receipts: many, fetchHealth: async (e) => { probed.push(e); return null; } });
  assert.equal(probed.length, RECEIPT_LIMIT);
});

test("receipts are read newest first, and a non-loopback endpoint is never a candidate", () => {
  const files = {
    "a/ready.json": { endpoint: "http://127.0.0.1:1", pid: 1, envInstance: "a" },
    "b/ready.json": { endpoint: "http://10.0.0.5:1", pid: 2, envInstance: "b" },
    "c/ready.json": { endpoint: "http://127.0.0.1:3", pid: 3, envInstance: "c" },
  };
  const key = (p) => p.replace(/\\/g, "/").split("/invocations/")[1];
  const io = {
    readdirSync: () => ["a", "b", "c", "d"],
    readFileSync: (p) => { const f = files[key(p)]; if (!f) throw new Error("ENOENT"); return JSON.stringify(f); },
    statSync: (p) => ({ mtimeMs: { "a/ready.json": 1, "c/ready.json": 5 }[key(p)] ?? 0 }),
  };
  assert.deepEqual(readyReceipts("/root", io).map((r) => r.pid), [3, 1]);
});

test("the doctor judges the discovered daemon when the configured address is silent", async () => {
  const envBody = { processes: [], terminals: { available: true } };
  const knock = async (url) => (url.startsWith(LIVE.endpoint) ? { ok: true, status: 200, body: envBody } : { ok: false, error: "ECONNREFUSED" });
  const checks = await collectEnvironmentChecks({
    endpoint: "http://127.0.0.1:8802",
    discoverEndpoint: async () => LIVE.endpoint,
    knock,
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const environment = checks.find((c) => c.id === "environment");
  assert.ok(environment, `CONTROL: an environment check was produced: ${checks.map((c) => c.id)}`);
  assert.equal(environment.state, STATE.PASSED, JSON.stringify(environment));
  assert.match(environment.detail, /63204/, "the check names the daemon it found");
});
