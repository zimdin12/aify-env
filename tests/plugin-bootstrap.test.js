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
import { bootstrapReport, credentialValue, startServicePlugins } from "../lib/plugin-bootstrap.mjs";

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

test("a credential RESOLUTION is not a key, and the difference 401s everything", () => {
  // THE DEFECT THIS PINS, found against a live service on 2026-09-02. `credentialForTarget` returns
  // {state, value, source, detail, ref}. The daemon returned the whole object, so "[object Object]"
  // went into the X-API-Key header and every plugin heartbeat was refused -- while the advertiser
  // forty lines below, which takes `.value`, kept working. The symptom was indistinguishable from
  // having no credential at all, which is why it cost a debugging session instead of a red test.
  assert.equal(credentialValue({ state: "ok", value: "banana", source: "store" }), "banana");
  assert.equal(credentialValue({ state: "absent", value: "" }), "");
});

test("anything that is not a string becomes empty, never the word 'undefined'", () => {
  // An empty key sends no header at all; the STRING "undefined" is a wrong key, and the service
  // reports those differently. Stringifying blindly is how one becomes the other.
  for (const bad of [null, undefined, {}, { value: undefined }, { value: 42 }, 7, []]) {
    assert.equal(credentialValue(bad), "", `${JSON.stringify(bad)} did not become ""`);
  }
});

test("a bare string is accepted, so a simpler resolver is not broken by this", () => {
  assert.equal(credentialValue("a-key"), "a-key");
});
