// The seam that lets a service teach this host to talk to it without this host learning about it.
//
// WHAT THESE PIN, and why each one is here rather than being obvious:
//   * the narrowed process view really is narrow -- a plugin that can reach the Runner can supersede
//     or reap work it does not own, which is the failure this project has had twice from the other
//     direction;
//   * a half-declared plugin is refused at REGISTRATION, because the alternative is failing at
//     teardown, in the dark, holding processes nothing will now reap;
//   * one failing plugin does not take the host down, because aify-env's own job does not depend on
//     any service being reachable and a host that died with one would take every agent with it;
//   * the credential is fetched per use, not captured -- a plugin holding a boot-time copy is
//     exactly what cost a day on 2026-09-02.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PluginHost,
  PluginProcesses,
  ServicePlugins,
  pluginProblem,
} from "../lib/service-plugins.mjs";

/** A Runner stand-in that records what was asked of it. */
function fakeRunner() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); return `${name}-ok`; };
  return {
    calls,
    start: async (spec) => { calls.push(["start", spec]); return { id: "p1", spec }; },
    subscribe: record("subscribe"),
    canStream: record("canStream"),
    write: record("write"),
    resize: record("resize"),
    stop: async (id, opts) => { calls.push(["stop", id, opts]); return "stopped"; },
    relabel: record("relabel"),
    release: record("release"),
    list: record("list"),
    history: record("history"),
    instance: record("instance"),
  };
}

const okPlugin = (name, hooks = {}) => ({
  name,
  start: hooks.start || (async () => {}),
  stop: hooks.stop || (async () => {}),
});

test("the process view exposes what a plugin needs and nothing else", () => {
  const runner = fakeRunner();
  const view = new PluginProcesses(runner);
  for (const method of ["start", "subscribe", "canStream", "write", "resize", "stop", "relabel", "list"]) {
    assert.equal(typeof view[method], "function", `${method} is missing from the plugin's view`);
  }
  // The host's OWN levers stay out of reach. `release` drops a process from the registry without
  // stopping it and `history` and `instance` are the host's identity -- a plugin holding those can
  // orphan another plugin's work or impersonate the environment.
  for (const method of ["release", "history", "instance"]) {
    assert.equal(view[method], undefined, `${method} must not be reachable from a plugin`);
  }
});

test("CONTROL: the fake Runner really has the methods the view withholds", () => {
  // Without this, the assertions above pass on a Runner that never had them, and the narrowing is
  // proven against nothing.
  const runner = fakeRunner();
  for (const method of ["release", "history", "instance"]) {
    assert.equal(typeof runner[method], "function");
  }
});

test("the view passes calls straight through, holding no state of its own", async () => {
  const runner = fakeRunner();
  const view = new PluginProcesses(runner);
  await view.start({ launcher: "x" });
  view.write("p1", "hello");
  view.resize("p1", 80, 24);
  await view.stop("p1", { phase: () => {} });
  assert.deepEqual(runner.calls.map((c) => c[0]), ["start", "write", "resize", "stop"]);
});

test("a view without a Runner is refused rather than failing on first use", () => {
  assert.throws(() => new PluginProcesses(null), TypeError);
  assert.throws(() => new PluginProcesses({}), TypeError);
});

test("a half-declared plugin is refused at registration", () => {
  assert.match(pluginProblem(null), /not an object/);
  assert.match(pluginProblem({ start() {}, stop() {} }), /no name/);
  assert.match(pluginProblem({ name: "x", stop() {} }), /no start/);
  assert.match(pluginProblem({ name: "x", start() {} }), /no stop/);
  assert.equal(pluginProblem(okPlugin("x")), "", "a complete plugin must be accepted");
});

test("two plugins cannot share a name", () => {
  const plugins = new ServicePlugins();
  assert.equal(plugins.register(okPlugin("aify-comms")), "");
  assert.match(plugins.register(okPlugin("aify-comms")), /already registered/);
  assert.deepEqual(plugins.names(), ["aify-comms"]);
});

test("one plugin failing to start does not stop the others", async () => {
  const started = [];
  const plugins = new ServicePlugins();
  plugins.register(okPlugin("first", { start: async () => { started.push("first"); } }));
  plugins.register(okPlugin("broken", { start: async () => { throw new Error("service unreachable"); } }));
  plugins.register(okPlugin("third", { start: async () => { started.push("third"); } }));

  const failures = await plugins.startAll(host());
  assert.deepEqual(started, ["first", "third"], "a later plugin must still start");
  assert.deepEqual(failures.map((f) => f.name), ["broken"]);
  assert.match(failures[0].error.message, /service unreachable/);
});

test("every plugin is stopped even when one throws", async () => {
  const stopped = [];
  const plugins = new ServicePlugins();
  plugins.register(okPlugin("first", { stop: async () => { stopped.push("first"); } }));
  plugins.register(okPlugin("broken", { stop: async () => { throw new Error("stuck"); } }));
  plugins.register(okPlugin("third", { stop: async () => { stopped.push("third"); } }));
  await plugins.startAll(host());

  const failures = await plugins.stopAll();
  // Reverse order, and ALL of them: a teardown that abandons the rest at the first error is how
  // processes outlive the thing that owned them.
  assert.deepEqual(stopped, ["third", "first"]);
  assert.deepEqual(failures.map((f) => f.name), ["broken"]);
});

test("stopping twice does not stop a plugin twice", async () => {
  const stops = [];
  const plugins = new ServicePlugins();
  plugins.register(okPlugin("one", { stop: async () => { stops.push(1); } }));
  await plugins.startAll(host());
  await plugins.stopAll();
  await plugins.stopAll();
  assert.deepEqual(stops, [1], "a second teardown must be a no-op, not a repeat");
});

test("a plugin that never started is never stopped", async () => {
  const stops = [];
  const plugins = new ServicePlugins();
  plugins.register(okPlugin("broken", {
    start: async () => { throw new Error("no"); },
    stop: async () => { stops.push("broken"); },
  }));
  await plugins.startAll(host());
  await plugins.stopAll();
  assert.deepEqual(stops, [], "stopping something that never started runs teardown on nothing");
});

test("the credential is fetched per use, not captured at start", async () => {
  // A plugin holding a boot-time copy keeps presenting the old key after a rotation, which is the
  // shape that cost a day: the credential was stored, and the process needing it had read its
  // absence at boot and never looked again.
  let current = "first";
  const h = host({ credential: async () => current });
  assert.equal(await h.credential(), "first");
  current = "rotated";
  assert.equal(await h.credential(), "rotated");
});

test("a host without a process view is refused", () => {
  assert.throws(() => new PluginHost({ processes: {} }), TypeError);
  assert.throws(() => new PluginHost({}), TypeError);
});

function host(extra = {}) {
  return new PluginHost({
    processes: new PluginProcesses(fakeRunner()),
    environmentId: "windows:test:default",
    ...extra,
  });
}
