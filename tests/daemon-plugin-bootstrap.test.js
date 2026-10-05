// The daemon's plugin assembly, without importing the daemon or starting real workers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startDaemonPlugins } from "../lib/daemon-plugin-bootstrap.mjs";
import { ServicePlugins } from "../lib/service-plugins.mjs";

function fixture() {
  const events = [];
  const registry = new ServicePlugins();
  const entry = { name: "fixture", endpoint: "http://fixture.invalid" };
  const runner = {
    async start(spec) { events.push(["start", spec]); return { id: "p1", label: spec.label }; },
    list: () => [],
  };
  let key = "first-fixture-key";
  let advertisement = { generation: 1 };
  let host;
  let seenShared;
  const shared = {
    machineId: "linux:fixture", dedicated: true, definitions: { marker: "same-store" },
    advertisement: async () => advertisement,
  };
  const paneOpener = async (record) => events.push(["pane", record]);
  paneOpener.prepare = (spec) => ({ ...spec, prepared: true });
  const plugin = {
    name: entry.name, endpoint: entry.endpoint,
    async start(given) { host = given; events.push("started"); },
    async stop() {}, async detach() { return { detached: true, held: 0 }; },
  };
  const io = {
    registry, runner, paneOpener,
    credential: async (asking) => { assert.equal(asking, entry); return key; },
    log: (line) => events.push(["log", line]),
    makeShared: () => { events.push("shared"); return shared; },
    readServices: () => { events.push("services"); return [entry]; },
    build: (services, context) => {
      seenShared = context;
      events.push(["build", services]);
      return { plugins: services.length ? [plugin] : [], unserved: [] };
    },
    report: (line) => events.push(["report", line]),
  };
  return { io, registry, entry, shared, events, get host() { return host; }, get seenShared() { return seenShared; },
    rotate() { key = "rotated-fixture-key"; advertisement = { generation: 2 }; } };
}

test("startup builds the host before reading context and registry, and reports the real starter's result", async () => {
  const f = fixture();
  await startDaemonPlugins(f.io);
  assert.deepEqual(f.events.slice(0, 4), ["shared", "services", ["build", [f.entry]], "started"]);
  assert.equal(f.seenShared, f.shared);
  assert.equal(f.host.environmentId, "");
  assert.deepEqual(f.registry.names(), ["fixture"]);
  assert.ok(f.events.some((event) => Array.isArray(event) && event[0] === "report" && /hosting work for: fixture/.test(event[1])));
});

test("the assembly refuses an invalid runner before reading any plugin context", async () => {
  const f = fixture();
  await assert.rejects(startDaemonPlugins({ ...f.io, runner: {} }), /PluginProcesses needs a Runner/);
  assert.deepEqual(f.events, []);
});

test("credentials and advertisements remain per-call, and both pane hooks reach the process adapter", async () => {
  const f = fixture();
  await startDaemonPlugins(f.io);
  assert.equal(await f.host.credential(f.entry), "first-fixture-key");
  assert.deepEqual(await f.seenShared.advertisement(), { generation: 1 });
  f.rotate();
  assert.equal(await f.host.credential(f.entry), "rotated-fixture-key");
  assert.deepEqual(await f.seenShared.advertisement(), { generation: 2 });
  await f.host.processes.start({ label: "fixture-worker" });
  assert.deepEqual(f.events.filter((event) => Array.isArray(event) && event[0] === "start"),
    [["start", { label: "fixture-worker", prepared: true }]]);
  assert.deepEqual(f.events.filter((event) => Array.isArray(event) && event[0] === "pane"),
    [["pane", { id: "p1", label: "fixture-worker" }]]);
});

test("registry following still coalesces an in-flight beat and permits the next one after completion", async () => {
  const f = fixture();
  const follow = await startDaemonPlugins(f.io);
  let release;
  const detached = new Promise((resolve) => { release = resolve; });
  const originalDetach = f.registry.detach.bind(f.registry);
  f.registry.detach = async (name) => { f.events.push(["detach", name]); await detached; return originalDetach(name); };
  follow([]);
  follow([]);
  assert.deepEqual(f.events.filter((event) => Array.isArray(event) && event[0] === "detach"), [["detach", "fixture"]]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.registry.names(), []);
  follow([f.entry]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.registry.names(), ["fixture"]);
});
