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
  // A FRAME THAT ACTUALLY THROWS, which the previous version of this test did not have.
  //
  // It threw from the FETCH -- and `knock` catches a failed fetch BY DESIGN and turns it into an
  // "unreachable" panel, because "asked and got nothing" is a fact worth painting. So `draw()`
  // resolved every time, the `.catch` this test is named for never ran, and the only thing left
  // being measured was how many timer ticks fit in a 60ms sleep. Mutating the loop to die on a
  // thrown frame left the test GREEN, which is how this was found: a test that cannot fail for its
  // stated reason manufactures confidence rather than providing it.
  //
  // Throwing from `write` is the real thing: it is called at the END of draw and nothing wraps it,
  // so the rejection reaches the loop exactly as a genuine paint failure would.
  const written = [];
  let frames = 0;
  const write = (text) => {
    frames += 1;
    // NOT THE FIRST. `startDashboard` awaits one draw before it returns, so a first-frame throw
    // would reject the constructor and test something else entirely.
    if (frames === 2) throw new Error("this frame could not be painted");
    written.push(text);
  };
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }),
    { intervalMs: 10, write, readFile: () => "" },
  ));

  // WAIT FOR THE CONDITION, NOT FOR A DURATION. The previous 60ms sleep was a measured flake: the
  // assertion needed three timer firings, Windows floors a timer at ~15ms, and eleven runs put the
  // real count at 4 or 5 with at least one at 2. A budget a third above its own cost is not a
  // budget. Polling returns as soon as the loop has proven it survived, so a healthy run is faster
  // than the old sleep and a genuinely dead loop costs the ceiling once rather than reddening the
  // suite at random.
  const deadline = Date.now() + 5_000;
  while (written.length <= 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  stop();

  assert.ok(frames > 2, `the loop stopped ticking after the failed frame (${frames} frame(s))`);
  assert.ok(written.length > 1,
    `a frame that threw stopped the view for good: ${written.length} painted of ${frames} attempted`);
});
const ESC = String.fromCharCode(27);

test("the FIRST frame clears, because the screen's contents are unknown", async () => {
  // There may be a shell prompt or half a log line up there. Treating an unknown screen as blank is
  // how a repaint leaves somebody's unfinished command sitting under the dashboard.
  const written = [];
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }),
    { once: true, clearScreen: true, write: (text) => written.push(text) },
  ));
  stop();
  assert.equal(written.length, 1, "the first frame did not paint");
  assert.ok(written[0].startsWith(`${ESC}[2J`), "the first frame did not clear");
});

test("A REDRAW OF AN UNCHANGED SCREEN IS SILENT", async () => {
  // The whole reason the full clear went. The old loop wrote a clear plus the entire frame twice a
  // second whether or not one character differed -- which the eye reads as flicker, and which a side
  // pane with live output in it could not survive.
  //
  // Driven through the interval rather than `once`, because the property belongs to the SECOND frame
  // of one instance: a fresh instance always faces an unknown screen and must clear.
  const written = [];
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }),
    { intervalMs: 5, clearScreen: true, write: (text) => written.push(text) },
  ));
  try {
    const afterFirst = written.length;
    assert.ok(afterFirst >= 1, "no first frame");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(written.length, afterFirst,
                 `an unchanged screen was repainted ${written.length - afterFirst} time(s)`);
  } finally {
    stop();
  }
});

test("A PIPE IS NOT A SCREEN: redirected output keeps the plain full write", async () => {
  // Escapes in a log are noise, and a service manager parsing this output would get cursor moves
  // interleaved with the banner. That is why `clearScreen` still gates the differential path.
  const written = [];
  const { stop } = await startDashboard(drawOptions(
    fakeFetch({ "8802/health": ENV_HEALTH }),
    { once: true, clearScreen: false, write: (text) => written.push(text) },
  ));
  stop();
  assert.equal(written.length, 1);
  assert.ok(!written[0].includes(ESC), "an escape reached a piped log");
  assert.match(written[0], /SERVICES/);
});
