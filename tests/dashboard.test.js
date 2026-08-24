// Collecting the view's data by ASKING, and reporting silence as silence.
//
// The collector's whole job is to turn answers into a snapshot without inventing any. The failure it
// has to avoid is reading "the service did not reply" as "no agents are running", which is a claim
// nobody made and is wrong exactly when it matters -- when the service is down.
//
// fetch is injected, so none of this touches a real service or the host's real registry.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  collectSnapshot,
  knock,
  startDashboard,
} from "../lib/dashboard.mjs";

const REGISTRY = JSON.stringify({
  version: 1,
  services: { "aify-comms": { endpoint: "http://svc:8800" } },
});

const ENV_HEALTH = {
  version: "0.6.0", terminals: true, processes: [], unknown: [],
  traffic: { requests: 3, bytesOut: 40 },
};

/** A fetch that answers from a table and records what it was asked, including each budget. */
function fakeFetch(table) {
  const asked = [];
  const impl = async (url, options) => {
    asked.push({ url, hasSignal: Boolean(options?.signal) });
    const entry = Object.entries(table).find(([suffix]) => String(url).endsWith(suffix));
    if (!entry) throw Object.assign(new Error("ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } });
    const [, value] = entry;
    if (value instanceof Error) throw value;
    return { json: async () => value };
  };
  impl.asked = asked;
  return impl;
}

const options = (fetchImpl) => ({
  endpoint: "http://127.0.0.1:8802",
  registryPath: "/registry.json",
  fetchImpl,
  readFile: () => REGISTRY,
});

test("an environment that is not answering is said out loud, not blanked", async () => {
  const snapshot = await collectSnapshot(options(fakeFetch({ "8800/health": { status: "healthy" } })));
  assert.equal(snapshot.version, "?");
  assert.match(snapshot.endpoint, /not answering/);
  assert.equal(snapshot.terminals.available, false);
  assert.deepEqual(snapshot.processes, []);
});

test("an unreadable registry means no services, not a crash", async () => {
  const snapshot = await collectSnapshot({
    endpoint: "http://127.0.0.1:8802",
    registryPath: "/nope.json",
    fetchImpl: fakeFetch({ "8802/health": ENV_HEALTH }),
    readFile: () => { throw new Error("ENOENT"); },
  });
  assert.deepEqual(snapshot.services, []);
});

test("knock turns a timeout into a stated reason rather than an exception", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const result = await knock("http://x/y", { fetchImpl: async () => { throw timeout; } });
  assert.deepEqual(result, { ok: false, error: "timed out" });
});

test("knock reports a connection error by its code", async () => {
  const refused = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const result = await knock("http://x/y", { fetchImpl: async () => { throw refused; } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ECONNREFUSED");
});

test("knock treats an unparseable body as no body, not as a failure", async () => {
  const result = await knock("http://x/y", {
    fetchImpl: async () => ({ json: async () => { throw new Error("bad json"); } }),
  });
  assert.deepEqual(result, { ok: true, body: null });
});

// ── startDashboard: draws, and owns nothing else ──────────────────────────────────────

const drawOptions = (fetchImpl, extra = {}) => ({
  endpoint: "http://127.0.0.1:8802",
  registryPath: "/registry.json",
  fetchImpl,
  readFile: () => REGISTRY,
  clearScreen: false,
  ...extra,
});

test("the first frame is drawn before the caller is resumed", async () => {
  // So a caller can await a visible screen rather than racing it.
  const written = [];
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH, "8800/health": { status: "healthy" } }),
    { once: true, write: (text) => written.push(text) },
  ));
  stop();
  assert.equal(written.length, 1, "no frame, or more than one, before resolving");
  assert.match(written[0], /SERVICES/);
});

test("once means once: nothing is scheduled", async () => {
  const written = [];
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }),
    { once: true, intervalMs: 5, write: (text) => written.push(text) },
  ));
  stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(written.length, 1, `a --once render kept drawing: ${written.length} frames`);
});

test("stop halts the redraw", async () => {
  const written = [];
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }),
    { intervalMs: 10, write: (text) => written.push(text) },
  ));
  await new Promise((resolve) => setTimeout(resolve, 45));
  const drawn = written.length;
  assert.ok(drawn > 1, "the loop never redrew, so stopping it proves nothing");
  stop();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(written.length, drawn, "frames kept arriving after stop()");
});

test("it registers no signal handler of its own", async () => {
  // THE REASON THIS LIVES IN lib. The script version owned a SIGINT handler that called
  // process.exit(0); embedding that in the daemon would put a second exit path beside the shutdown
  // one, and two racing handlers -- where the one that stopped nothing usually won -- is the defect
  // this repo just removed. What an interrupt means belongs to the caller.
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }), { once: true, write: () => {} },
  ));
  stop();
  assert.equal(process.listenerCount("SIGINT"), before.int, "the view claimed SIGINT");
  assert.equal(process.listenerCount("SIGTERM"), before.term, "the view claimed SIGTERM");
});

test("a frame that throws does not kill the loop", async () => {
  // The usual reason to have this open is watching for the moment something comes back.
  let calls = 0;
  const flaky = async (url) => {
    calls += 1;
    if (calls === 2) throw new Error("transient");
    return { json: async () => ENV_HEALTH };
  };
  const written = [];
  const { stop } = await startDashboard(drawOptions(flaky, {
    intervalMs: 10, write: (text) => written.push(text), readFile: () => "",
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.ok(written.length > 1, "one bad frame stopped the view for good");
});
