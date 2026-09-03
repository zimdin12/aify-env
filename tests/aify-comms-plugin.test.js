// The plugin's two loops, and the properties that decide whether a spawn can ever run.
//
// WHAT THESE PIN:
//   * the heartbeat interval sits WELL INSIDE the service's freshness window, because a value at or
//     near it makes every scheduling hiccup look like a dead bridge;
//   * starting does not depend on the service being up -- this host runs processes whether or not
//     aify-comms answers, and a plugin that threw on a cold service would take the host with it;
//   * a heartbeat failure is NAMED, because a host that cannot register as a claimer looks exactly
//     like one with no work, and telling those apart from outside cost a day on 2026-09-02;
//   * stopping tells the service, or `/spawn` keeps accepting work for a claimer that has gone.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PluginHost, PluginProcesses } from "../lib/service-plugins.mjs";
import { CommsApiError } from "../lib/plugins/aify-comms/api.mjs";
import {
  HEARTBEAT_INTERVAL_MS,
  MIN_PASS_INTERVAL_MS,
  RETRY_AFTER_ERROR_MS,
  createCommsPlugin,
} from "../lib/plugins/aify-comms/index.mjs";

/** The service's own freshness window, from aify-comms `service/env_status.py`. Duplicated here on
 *  purpose: this test's whole point is that our interval must stay inside it, and reading it from
 *  the sibling repo would make the assertion depend on that checkout being present. */
const SERVICE_FRESH_SECONDS = 90;
const NEWLINE = String.fromCharCode(10);
//: A launcher the allowlist accepts -- it judges contents, not names.
const LAUNCHER_TEXT = "#!/usr/bin/env bash" + NEWLINE + 'HARNESS_WRAPPER_VERSION="1.0.0"' + NEWLINE;

function fakeApi({ heartbeatThrows = null, requests = [] } = {}) {
  const beats = [];
  const reports = [];
  let index = 0;
  return {
    beats,
    reports,
    async heartbeat(body) {
      beats.push(body);
      if (heartbeatThrows) throw heartbeatThrows;
      return {};
    },
    async claim() {
      const next = requests[index++];
      // After the scripted requests run out, behave like a quiet service: answer nothing.
      return next ? { spawnRequest: next } : {};
    },
    async report(id, patch) { reports.push({ id, ...patch }); },
  };
}

function fakeRunner(started = { id: "proc-1", pid: 7 }) {
  return {
    starts: [],
    async start(spec) { this.starts.push(spec); return started; },
    subscribe() {}, canStream() { return true; }, write() {}, resize() {},
    async stop() {}, relabel() {}, release() {}, list() { return []; },
    history() { return {}; }, instance() { return "i"; },
  };
}

function makeHost(runner = fakeRunner()) {
  const logs = [];
  const host = new PluginHost({
    processes: new PluginProcesses(runner),
    environmentId: "windows:test:default",
    credential: async () => "banana",
    log: (m) => logs.push(m),
  });
  return { host, logs, runner };
}

/** A plugin wired to fakes, with timers that never actually fire so a test cannot hang. */
function makePlugin(api, extra = {}) {
  const timers = [];
  return {
    timers,
    plugin: createCommsPlugin({
      endpoint: "http://127.0.0.1:8800",
      version: "0.6.1",
      advertisement: async () => ({ hostname: "test-host", kind: "windows" }),
      cwdRoots: async () => ["C:/Users/Administrator"],
      windows: true,
      api,
      readFile: () => LAUNCHER_TEXT,
      setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeoutImpl: () => {},
      ...extra,
    }),
  };
}

test("the heartbeat interval sits well inside the service's freshness window", () => {
  // At or near 90s, a single GC pause or a slow beat reads as a dead bridge and every spawn is
  // refused while everything reports healthy.
  assert.ok(HEARTBEAT_INTERVAL_MS < (SERVICE_FRESH_SECONDS * 1000) / 2,
    `${HEARTBEAT_INTERVAL_MS}ms leaves no room for a missed beat inside a ${SERVICE_FRESH_SECONDS}s window`);
  assert.ok(RETRY_AFTER_ERROR_MS > 0 && RETRY_AFTER_ERROR_MS < HEARTBEAT_INTERVAL_MS,
    "a retry must be quicker than a heartbeat, or recovery waits on the slower of the two");
});

test("starting registers this host as a CLAIMER, which is the whole point", async () => {
  const api = fakeApi();
  const { plugin } = makePlugin(api);
  const { host } = makeHost();
  await plugin.start(host);
  assert.equal(api.beats.length, 1, "start must beat once, or nothing can claim until the timer fires");
  assert.equal(api.beats[0].hostname, "test-host", "the generic advertisement must travel with it");
  assert.equal(plugin.state().lastHeartbeatError, "");
  await plugin.stop();
});

test("a service that is DOWN does not stop the plugin starting", async () => {
  // aify-env's own job does not require aify-comms to answer. A plugin that threw here would take
  // every running agent down with the host.
  const api = fakeApi({ heartbeatThrows: new CommsApiError("connect ECONNREFUSED", { status: 0 }) });
  const { plugin } = makePlugin(api);
  const { host, logs } = makeHost();
  await plugin.start(host);
  assert.match(plugin.state().lastHeartbeatError, /unreachable|ECONNREFUSED/,
    "a host that cannot register looks exactly like one with no work unless this is named");
  assert.ok(logs.some((l) => /heartbeat failed/.test(l)), "the failure must reach the host's log");
  await plugin.stop();
});

test("a REFUSED heartbeat is named with its status, not collapsed into unreachable", async () => {
  // 401 sends someone to a credential; a connection error sends them to a process. Collapsing them
  // is how "the service did not answer" gets reported about a service that is up and rejecting.
  const api = fakeApi({ heartbeatThrows: new CommsApiError("POST -> 401", { status: 401 }) });
  const { plugin } = makePlugin(api);
  const { host } = makeHost();
  await plugin.start(host);
  assert.match(plugin.state().lastHeartbeatError, /401/);
  await plugin.stop();
});

test("a claimed request REGISTERS a warm agent and starts NOTHING", async () => {
  // THE MODEL CORRECTED 2026-09-03, after the first real spawn. Six requests were claimed within
  // seconds and all six failed with "a start request must name a launcher to run": the pass built a
  // start spec from `request.launcher`, a field the wire has never carried. The bridge code this
  // replaced -- `mcp/stdio/spawn-loop.mjs` -- contains ZERO process starts and reports `running`
  // with its own pid; the worker is started later by the terminal control path, when the service
  // asks for it. That is `managed-warm`, and every spawn this system issues uses it.
  //
  // ASSERTING THE RUNNER IS UNTOUCHED is the whole point: a process started here is one nothing has
  // work for, and it would put runtime launch composition -- model flags, session handles,
  // AIFY_AGENT_ID -- inside the general host.
  const api = fakeApi({
    requests: [{
      id: "req-1",
      agentId: "sc-lead",
      workspace: "C:/Users/Administrator/sand_castle",
    }],
  });
  const { plugin } = makePlugin(api);
  const { host, runner } = makeHost();
  await plugin.start(host);
  await new Promise((resolve) => setImmediate(resolve));
  await plugin.stop();

  assert.equal(runner.starts.length, 0, "a claim must start no process");
  assert.deepEqual(api.reports.map((r) => r.status), ["starting", "running"]);
  assert.equal(plugin.state().claimedTotal, 1);
  assert.equal(plugin.state().lastClaim, "registered");
});

test("stopping tells the service it is no longer a claimer", async () => {
  // Without this the row stays fresh for its whole window and `/spawn` accepts work for a claimer
  // that has gone -- the queued-for-ever shape arriving by a different route.
  const api = fakeApi();
  const { plugin } = makePlugin(api);
  const { host } = makeHost();
  await plugin.start(host);
  await plugin.stop();
  const last = api.beats[api.beats.length - 1];
  assert.equal(last.status, "offline");
});

test("a service unreachable on the way down does not break teardown", async () => {
  const api = fakeApi();
  const { plugin } = makePlugin(api);
  const { host } = makeHost();
  await plugin.start(host);
  api.heartbeat = async () => { throw new CommsApiError("gone", { status: 0 }); };
  await plugin.stop();  // must not throw
});

test("the plugin satisfies the host's own plugin contract", async () => {
  const { pluginProblem } = await import("../lib/service-plugins.mjs");
  const { plugin } = makePlugin(fakeApi());
  assert.equal(pluginProblem(plugin), "", "a plugin the registry would refuse cannot be run at all");
  assert.equal(plugin.name, "aify-comms");
});

test("the claim loop never spins, however fast the service answers", async () => {
  // THE DEFECT THIS PINS, found the first time the loop met a fake that answered instantly: with no
  // floor between passes the loop re-enters with nothing to await, pins a core and hammers the
  // endpoint. Production hides it behind the service's 25s long-poll -- until the day the service
  // stops honouring `waitMs`, when the symptom is a machine at 100% with no error anywhere.
  const pauses = [];
  const api = fakeApi();                       // answers `{}` immediately, for ever
  const { plugin } = makePlugin(api, {
    setTimeoutImpl: (fn, ms) => { pauses.push(ms); return setImmediate(fn); },
    clearTimeoutImpl: (h) => clearImmediate(h),
  });
  const { host } = makeHost();
  await plugin.start(host);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await plugin.stop();

  const claimPauses = pauses.filter((ms) => ms !== HEARTBEAT_INTERVAL_MS);
  assert.ok(claimPauses.length > 0, "the loop ran no passes, so this proves nothing");
  assert.ok(claimPauses.every((ms) => ms >= MIN_PASS_INTERVAL_MS),
    `a pass waited ${Math.min(...claimPauses)}ms; every pass must yield at least ` +
    `${MIN_PASS_INTERVAL_MS}ms or an instant-answering service becomes a hot loop`);
});

test("an unreachable service backs off further than an idle one", async () => {
  // Idle already waited on the service's own long-poll; unreachable means retrying into a hole.
  const pauses = [];
  const api = fakeApi();
  api.claim = async () => { throw new CommsApiError("ECONNREFUSED", { status: 0 }); };
  const { plugin } = makePlugin(api, {
    setTimeoutImpl: (fn, ms) => { pauses.push(ms); return setImmediate(fn); },
    clearTimeoutImpl: (h) => clearImmediate(h),
  });
  const { host } = makeHost();
  await plugin.start(host);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await plugin.stop();
  assert.ok(pauses.includes(RETRY_AFTER_ERROR_MS),
    "an unreachable service must back off further than the idle floor");
});

test("state is reported so silence can be explained", async () => {
  // An operator seeing no spawns needs to know whether nothing was offered or nothing could be
  // reached. Inferring that from silence is what cost a day.
  const api = fakeApi();
  const { plugin } = makePlugin(api);
  const { host } = makeHost();
  const before = plugin.state();
  // `claimer` joined on 2026-09-03: whether the service RECOGNISES this host as the claimer, which
  // a 200 does not answer. It starts null -- unknown, never yes -- because "nothing has beaten yet"
  // and "the service is too old to say" are the same state from here and neither is acceptance.
  assert.deepEqual(Object.keys(before).sort(),
    ["claimedTotal", "claimer", "lastClaim", "lastHeartbeat", "lastHeartbeatError"]);
  assert.equal(before.claimer, null);
  await plugin.start(host);
  assert.ok(plugin.state().lastHeartbeat, "a successful beat must be visible");
  await plugin.stop();
});

// A HEARTBEAT THE SERVICE KEPT vs ONE IT DISCARDED. Added 2026-09-03.
//
// `/environments/heartbeat` arbitrates supersession and may throw a beat away while answering
// `ok: true` -- so a 200 says the request was well-formed, never that this host is the claimer.
// Measured 2026-09-02: this plugin sent its start time in the wrong place, every beat landed on
// that branch, and it kept beating for hours believing it was the claimer while `/spawn` refused
// every request and both sides reported healthy. The service now says which it did; these pin that
// the plugin READS it, because a field nobody reads changes nothing.

/** A fake API whose heartbeat answers with whatever the service would have said. */
function apiAnswering(answer) {
  return {
    beats: [],
    async heartbeat(body) { this.beats.push(body); return answer; },
    async claim() { return {}; },
    async report() {},
  };
}

test("a beat the service DISCARDED is reported, not counted as success", async () => {
  const { host, logs } = makeHost();
  const { plugin } = makePlugin(apiAnswering({
    ok: true,
    claimer: { accepted: false, bridgeId: "someone-else", reason: "an existing bridge started later" },
  }));
  await plugin.start(host);

  const said = logs.join(String.fromCharCode(10));
  assert.match(said, /did NOT accept this host as the claimer/);
  assert.match(said, /someone-else/, "the message must name who DOES hold it");
  assert.match(said, /Spawns here will be refused/, "and what it means for the operator");
  assert.equal(plugin.state().claimer?.accepted, false);
  assert.match(plugin.state().lastHeartbeatError, /not the claimer/,
    "a discarded beat must not leave the error field reading clean");
});

test("an ACCEPTED beat says nothing, because a line every 30s trains an operator to skim", async () => {
  const { host, logs } = makeHost();
  const { plugin } = makePlugin(apiAnswering({ ok: true, claimer: { accepted: true, bridgeId: "me", reason: "" } }));
  await plugin.start(host);
  assert.equal(logs.filter((l) => /claimer/.test(String(l))).length, 0);
  assert.equal(plugin.state().claimer?.accepted, true);
  assert.equal(plugin.state().lastHeartbeatError, "");
});

test("a service too old to answer is UNKNOWN, never a refusal", async () => {
  // Every host on a service one version back would otherwise log a fault it does not have, which is
  // the fastest way to make a real warning unreadable.
  const { host, logs } = makeHost();
  const { plugin } = makePlugin(apiAnswering({ ok: true, environment: {} }));
  await plugin.start(host);
  assert.equal(logs.filter((l) => /claimer/.test(String(l))).length, 0);
  assert.equal(plugin.state().claimer, null, "absent must read as unknown, not as accepted");
  assert.equal(plugin.state().lastHeartbeatError, "");
});
