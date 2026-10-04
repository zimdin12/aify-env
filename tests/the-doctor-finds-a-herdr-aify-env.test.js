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
const found = async (options) => (await discoverServingEndpoint(options)).endpoint;

/**
 * Invocation directories as `{name: {mtime, ready}}`. `ready` absent means the launch never became
 * ready, so its ready.json does not exist; a string is written as-is (garbage). Reads are counted.
 */
function fakeFs(dirs) {
  const reads = [];
  const nameOf = (p) => p.replace(/\\/g, "/").split("/invocations/")[1].split("/")[0];
  const io = {
    readdirSync: () => Object.keys(dirs),
    statSync: (p) => {
      const dir = dirs[nameOf(p)];
      if (p.replace(/\\/g, "/").endsWith("/ready.json") && dir?.ready === undefined) throw new Error("ENOENT");
      return { mtimeMs: dir.mtime };
    },
    readFileSync: (p) => {
      reads.push(nameOf(p));
      const { ready } = dirs[nameOf(p)];
      return typeof ready === "string" ? ready : JSON.stringify(ready);
    },
  };
  return { io, reads };
}
const receiptFor = (n) => ({ endpoint: `http://127.0.0.1:${40000 + n}`, pid: n + 1, envInstance: `i${n}` });

test("the one receipt whose daemon answers with its own pid and instance is found", async () => {
  assert.equal(await found({ receipts: [LIVE, STALE], fetchHealth }), LIVE.endpoint);
});

test("a receipt whose port now answers as someone else is not believed", async () => {
  assert.equal(await found({ receipts: [{ ...STALE, endpoint: LIVE.endpoint }], fetchHealth }), "");
});

test("two live daemons are left unresolved, not guessed between", async () => {
  const other = { endpoint: "http://127.0.0.1:60000", pid: 2, envInstance: "i2", writtenMs: 2 };
  const both = async (e) => (e === other.endpoint ? { pid: 2, instance: "i2" } : fetchHealth(e));
  assert.equal(await found({ receipts: [LIVE, other], fetchHealth: both }), "");
});

test("only the newest receipts are probed, and the rest are counted as unchecked", async () => {
  const probed = [];
  const many = Array.from({ length: 20 }, (_, i) => ({ ...STALE, endpoint: `http://127.0.0.1:${50000 + i}` }));
  const answer = await discoverServingEndpoint({ receipts: many, unread: 5, fetchHealth: async (e) => { probed.push(e); return null; } });
  assert.equal(probed.length, RECEIPT_LIMIT);
  assert.deepEqual(answer, { endpoint: "", unchecked: 5 + 20 - RECEIPT_LIMIT });
});

test("receipts are read newest first, and a non-loopback endpoint is never a candidate", () => {
  const { io } = fakeFs({
    a: { mtime: 1, ready: { endpoint: "http://127.0.0.1:1", pid: 1, envInstance: "a" } },
    b: { mtime: 3, ready: { endpoint: "http://10.0.0.5:1", pid: 2, envInstance: "b" } },
    c: { mtime: 5, ready: { endpoint: "http://127.0.0.1:3", pid: 3, envInstance: "c" } },
    d: { mtime: 9 },
  });
  assert.deepEqual(readyReceipts("/root", io).receipts.map((r) => r.pid), [3, 1]);
});

test("only the newest receipts are READ, however many invocations there are (review, T3)", () => {
  // The probe cap applied after every ready.json had been read: 1,000 invocations cost 1,000 reads.
  const dirs = Object.fromEntries(Array.from({ length: 1000 }, (_, n) => [`inv-${n}`, { mtime: n, ready: receiptFor(n) }]));
  const { io, reads } = fakeFs(dirs);
  const { receipts, unread } = readyReceipts("/root", io);
  assert.equal(reads.length, RECEIPT_LIMIT, `${reads.length} receipt files read`);
  assert.deepEqual(receipts.map((r) => r.pid), [1000, 999, 998, 997, 996, 995, 994, 993], "not the newest receipts");
  assert.equal(unread, 1000 - RECEIPT_LIMIT);
});

test("launches that never became ready cannot crowd out an older live daemon (review, T3 round 2)", async () => {
  // Dating the DIRECTORIES let eight later failed launches, none with a ready.json, fill the eight
  // slots, and the live daemon's receipt was never read.
  const dirs = { live: { mtime: 1, ready: { endpoint: LIVE.endpoint, pid: LIVE.pid, envInstance: LIVE.envInstance } } };
  for (let n = 0; n < 8; n += 1) dirs[`failed-${n}`] = { mtime: 10 + n };
  const { io, reads } = fakeFs(dirs);
  const scan = readyReceipts("/root", io);
  assert.deepEqual(reads, ["live"], "a directory without a ready.json was read");
  assert.equal(await found({ ...scan, fetchHealth }), LIVE.endpoint);
});

/** The environment check from a discovery answer, with the configured address silent. */
async function environmentFrom(answer, envBody = { processes: [], terminals: { available: true } }) {
  const checks = await collectEnvironmentChecks({
    endpoint: "http://127.0.0.1:8802",
    discoverEndpoint: async () => answer,
    knock: async (url) => (answer.endpoint && url.startsWith(answer.endpoint)
      ? { ok: true, status: 200, body: envBody } : { ok: false, error: "ECONNREFUSED" }),
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  return checks.find((c) => c.id === "environment");
}

test("content opens are capped whatever the receipts hold, and the rest is unchecked (review, T3 round 3)", async () => {
  // Capping VALID receipts let 1,000 malformed ready.json files cost 1,000 opens.
  const dirs = Object.fromEntries(Array.from({ length: 1000 }, (_, n) => [`bad-${n}`, { mtime: n, ready: "{not json" }]));
  const { io, reads } = fakeFs(dirs);
  const scan = readyReceipts("/root", io);
  assert.equal(reads.length, RECEIPT_LIMIT, `${reads.length} receipt files opened`);
  // The opened eight are malformed, so they are unreadable, not checked (review of 3f1e1ec): all 1,000 are unchecked.
  assert.deepEqual(scan, { receipts: [], unread: 1000 - RECEIPT_LIMIT, unreadable: RECEIPT_LIMIT });
  const answer = await discoverServingEndpoint({ ...scan, fetchHealth });
  assert.deepEqual(answer, { endpoint: "", unchecked: 1000 });
  assert.equal((await environmentFrom(answer)).state, STATE.UNANSWERED, "a partial look claimed no environment");
});

test("eight malformed newer receipts leave an older live one unchecked, and say so", async () => {
  const dirs = { live: { mtime: 1, ready: receiptFor(1) } };
  for (let n = 0; n < 8; n += 1) dirs[`bad-${n}`] = { mtime: 10 + n, ready: "{not json" };
  const { io } = fakeFs(dirs);
  assert.deepEqual(readyReceipts("/root", io), { receipts: [], unread: 1, unreadable: 8 });
});

test("a live daemon found among the checked receipts is judged, and unchecked older ones are named (review, T3 round 3)", async () => {
  // NARROWED GUARANTEE: uniqueness holds among the receipts checked. On the operator's host 15 ready
  // receipts sat under a cap of 8, so "unresolved whenever any went unchecked" would read UNANSWERED on
  // every run. A second live daemon among the unchecked ones is not looked for, and the detail says so.
  const dirs = {};
  for (let n = 0; n < 9; n += 1) dirs[`inv-${n}`] = { mtime: n, ready: receiptFor(n) };
  const live = (n) => receiptFor(n).endpoint;
  const { io } = fakeFs(dirs);
  const answer = await discoverServingEndpoint({
    ...readyReceipts("/root", io),
    fetchHealth: async (e) => ([8, 0].map(live).includes(e) ? { pid: Number(e.split(":")[2]) - 40000 + 1, instance: `i${Number(e.split(":")[2]) - 40000}` } : null),
  });
  assert.deepEqual(answer, { endpoint: live(8), unchecked: 1 }, "the newest live receipt among those checked");
  const environment = await environmentFrom(answer);
  assert.equal(environment.state, STATE.PASSED);
  assert.match(environment.detail, /1 older herdr-aify env receipt was not checked/, environment.detail);
});

test("a live daemon older than eight valid stale receipts is reported as unchecked, not as none", async () => {
  const dirs = { live: { mtime: 1, ready: { endpoint: LIVE.endpoint, pid: LIVE.pid, envInstance: LIVE.envInstance } } };
  for (let n = 0; n < 8; n += 1) dirs[`stale-${n}`] = { mtime: 10 + n, ready: receiptFor(n) };
  const { io } = fakeFs(dirs);
  const answer = await discoverServingEndpoint({ ...readyReceipts("/root", io), fetchHealth });
  assert.deepEqual(answer, { endpoint: "", unchecked: 1 });

  const checks = await collectEnvironmentChecks({
    endpoint: "http://127.0.0.1:8802",
    discoverEndpoint: async () => answer,
    knock: async () => ({ ok: false, error: "ECONNREFUSED" }),
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const environment = checks.find((c) => c.id === "environment");
  assert.equal(environment.state, STATE.UNANSWERED, `a partial look claimed absence: ${JSON.stringify(environment)}`);
  assert.match(environment.detail, /1 older herdr-aify env receipt was not checked/);
});

test("a receipt or an answer without a real pid and instance authorizes nothing (review, T3)", async () => {
  const at = "http://127.0.0.1:55555";
  const answers = { [at]: { pid: 123 } };
  const fetch = async (e) => answers[e] ?? null;
  assert.equal(await found({ receipts: [{ endpoint: at, pid: 123, envInstance: "" }], fetchHealth: fetch }), "",
    "an empty receipt instance matched an answer without one");
  answers[at] = { pid: 123, instance: "" };
  assert.equal(await found({ receipts: [{ endpoint: at, pid: 123, envInstance: "" }], fetchHealth: fetch }), "",
    "an empty instance on both sides matched");
  answers[at] = { pid: 123, instance: "i1" };
  assert.equal(await found({ receipts: [{ endpoint: at, pid: 123, envInstance: "i1" }], fetchHealth: fetch }), at,
    "CONTROL: a real pid and instance on both sides is trusted");
  assert.equal(await found({ receipts: [{ endpoint: at, pid: Number.NaN, envInstance: "i1" }], fetchHealth: async () => ({ pid: Number.NaN, instance: "i1" }) }), "",
    "a missing pid matched a missing pid");

  const { io } = fakeFs({
    a: { mtime: 1, ready: { endpoint: "http://127.0.0.1:1", pid: 1 } },
    b: { mtime: 1, ready: { endpoint: "http://127.0.0.1:2", envInstance: "b" } },
    c: { mtime: 1, ready: { endpoint: "http://127.0.0.1:3", pid: "3x", envInstance: "c" } },
    d: { mtime: 1, ready: { endpoint: "http://127.0.0.1:4", pid: 4, envInstance: "d" } },
  });
  assert.deepEqual(readyReceipts("/root", io).receipts.map((r) => r.pid), [4], "a malformed receipt became a candidate");
});

test("the doctor judges the discovered daemon when the configured address is silent, and adds nothing when all were checked", async () => {
  const envBody = { processes: [], terminals: { available: true } };
  const knock = async (url) => (url.startsWith(LIVE.endpoint) ? { ok: true, status: 200, body: envBody } : { ok: false, error: "ECONNREFUSED" });
  const checks = await collectEnvironmentChecks({
    endpoint: "http://127.0.0.1:8802",
    discoverEndpoint: async () => ({ endpoint: LIVE.endpoint, unchecked: 0 }),
    knock,
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const environment = checks.find((c) => c.id === "environment");
  assert.ok(environment, `CONTROL: an environment check was produced: ${checks.map((c) => c.id)}`);
  assert.equal(environment.state, STATE.PASSED, JSON.stringify(environment));
  assert.match(environment.detail, /63204/, "the check names the daemon it found");
  assert.doesNotMatch(environment.detail, /not checked/, "CONTROL: nothing unchecked, nothing said");
});

test("nothing found and nothing unchecked is still a plain failure", async () => {
  const checks = await collectEnvironmentChecks({
    endpoint: "http://127.0.0.1:8802",
    discoverEndpoint: async () => ({ endpoint: "", unchecked: 0 }),
    knock: async () => ({ ok: false, error: "ECONNREFUSED" }),
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  assert.equal(checks.find((c) => c.id === "environment").state, STATE.FAILED);
});
