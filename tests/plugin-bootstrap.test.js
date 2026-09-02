// Starting the service plugins -- the CALL, tested, because the daemon that makes it cannot be.
//
// `bin/aify-env.mjs` starts the environment on import, which supersedes the one already serving and
// reaps its managed workers. So every line left in there is proven only by running the daemon, and
// nobody does that in a test. This file exercises the bootstrap the daemon calls.
//
// WHAT IT PINS. Nothing throws: this host runs processes whether or not a service answers, and a
// daemon that died because one was down would take every running agent with it. And every outcome is
// SAID -- a service registered with nothing to host its work is the exact silence that cost a day,
// where a row read `online`, spawns were refused, and no component explained why.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";
import { bootstrapReport, startServicePlugins } from "../lib/plugin-bootstrap.mjs";

function fakeHost() {
  const runner = {
    async start() { return { id: "p", pid: 1 }; },
    subscribe() {}, canStream() { return true; }, write() {}, resize() {},
    async stop() {}, relabel() {}, release() {}, list() { return []; },
    history() { return {}; }, instance() { return "i"; },
  };
  return new PluginHost({ processes: new PluginProcesses(runner), credential: async () => "k" });
}

const plugin = (name, hooks = {}) => ({
  name,
  start: hooks.start || (async () => {}),
  stop: hooks.stop || (async () => {}),
});

test("a served registry starts its plugins and says so", async () => {
  const outcome = await startServicePlugins({
    registry: new ServicePlugins(),
    host: fakeHost(),
    services: [{ name: "aify-comms", endpoint: "http://x" }],
    build: () => ({ plugins: [plugin("aify-comms")], unserved: [] }),
  });
  assert.deepEqual(outcome.started, ["aify-comms"]);
  assert.deepEqual(outcome.failed, []);
  assert.match(bootstrapReport(outcome).join("\n"), /hosting work for: aify-comms/);
});

test("a service with no plugin is NAMED, not passed over in silence", async () => {
  // The exact failure this exists for: a service registered, its row online, spawns refused, and
  // nothing anywhere responsible for saying "nothing here hosts its work".
  const outcome = await startServicePlugins({
    registry: new ServicePlugins(),
    host: fakeHost(),
    services: [{ name: "aify-other", endpoint: "http://y" }],
    build: () => ({ plugins: [], unserved: ["aify-other"] }),
  });
  assert.deepEqual(outcome.started, []);
  assert.match(bootstrapReport(outcome).join("\n"), /registered but no plugin to host their work: aify-other/);
});

test("a plugin that fails to start does not stop the others, and is reported", async () => {
  const outcome = await startServicePlugins({
    registry: new ServicePlugins(),
    host: fakeHost(),
    services: [],
    build: () => ({
      plugins: [
        plugin("good"),
        plugin("bad", { start: async () => { throw new Error("service unreachable"); } }),
      ],
      unserved: [],
    }),
  });
  assert.deepEqual(outcome.started, ["good"]);
  assert.deepEqual(outcome.failed.map((f) => f.name), ["bad"]);
  assert.match(bootstrapReport(outcome).join("\n"), /plugin "bad" failed to start: service unreachable/);
});

test("an unreadable registry is reported, and this host keeps running", async () => {
  // A registry we cannot read is not a reason to stop running processes for whoever already asked.
  const outcome = await startServicePlugins({
    registry: new ServicePlugins(),
    host: fakeHost(),
    services: [],
    build: () => { throw new Error("ENOENT services.json"); },
  });
  assert.deepEqual(outcome.started, []);
  assert.equal(outcome.failed.length, 1);
  assert.match(bootstrapReport(outcome).join("\n"), /ENOENT/);
});

test("a malformed plugin is refused and named, rather than failing at teardown", async () => {
  const outcome = await startServicePlugins({
    registry: new ServicePlugins(),
    host: fakeHost(),
    services: [],
    build: () => ({ plugins: [{ name: "half", start() {} }], unserved: [] }),
  });
  assert.equal(outcome.refused.length, 1);
  assert.match(bootstrapReport(outcome).join("\n"), /plugin refused: .*no stop/);
});

test("the report says nothing when there is nothing to say", () => {
  // A daemon that printed a line every boot for the ordinary case trains its operator to skim, and
  // the one line that matters is then skimmed too.
  assert.deepEqual(bootstrapReport({}), []);
});

test("startServicePlugins never throws, whatever the build does", async () => {
  for (const build of [
    () => { throw new Error("boom"); },
    () => ({ plugins: [plugin("x", { start: async () => { throw new Error("nope"); } })], unserved: [] }),
    () => ({ plugins: [], unserved: [] }),
  ]) {
    const outcome = await startServicePlugins({
      registry: new ServicePlugins(), host: fakeHost(), services: [], build,
    });
    assert.ok(outcome && Array.isArray(outcome.started), "an outcome must always come back");
  }
});
