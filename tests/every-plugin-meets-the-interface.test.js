// Every plugin the host can build meets the interface in lib/plugins/ports.mjs (0.9 plan P0 C10).
//
// Built through `pluginsForServices`, the host's own path, for every name `servicesWithPlugins` reports, with a stub
// context: no service is contacted, nothing is started. A plugin added to FACTORIES is checked here without anyone
// remembering to add it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { pluginsForServices, servicesWithPlugins } from "../lib/plugins/index.mjs";
import { pluginProblem } from "../lib/service-plugins.mjs";

const stubContext = {
  version: "test", machineId: "win32:conformance", dedicated: false, windows: true,
  advertisement: async () => ({}), cwdRoots: async () => [], watchRoots: async () => ({ roots: [], problems: [] }),
  definitions: { list: async () => ({ definitions: [] }), snapshot: async () => ({ complete: false, incomplete: {} }) },
  installedHarnesses: async () => new Set(),
  setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
};

function everyPlugin() {
  const names = servicesWithPlugins();
  const { plugins, unserved } = pluginsForServices(names.map((name) => ({ name, endpoint: "http://127.0.0.2:1" })), stubContext);
  assert.deepEqual(unserved, [], "every name the host reports has a factory");
  assert.equal(plugins.length, names.length, "one plugin per name");
  return plugins;
}

test("EVERY PLUGIN passes the host's own refusal check", () => {
  const plugins = everyPlugin();
  assert.ok(plugins.length >= 1, "CONTROL: there is at least one plugin to check");
  for (const plugin of plugins) assert.equal(pluginProblem(plugin), "", plugin.name);
});

test("WHAT A DOCTOR READS has the shape it reads: an object, and problems as a list of strings", () => {
  for (const plugin of everyPlugin()) {
    if (!("state" in plugin)) continue;
    const state = plugin.state();
    assert.equal(typeof state, "object", plugin.name);
    assert.ok(state !== null && !Array.isArray(state), plugin.name);
    if ("problems" in state) {
      assert.ok(Array.isArray(state.problems) && state.problems.every((p) => typeof p === "string"), `${plugin.name}: problems`);
    }
  }
});

test("STOP is safe before start and safe twice", async () => {
  for (const plugin of everyPlugin()) {
    await plugin.stop();
    await plugin.stop();
  }
});

test("THE CHECK REFUSES what the interface rules out, and names the plugin", () => {
  const ok = { name: "x", start: async () => {}, stop: async () => {} };
  assert.equal(pluginProblem(ok), "", "CONTROL: the minimum is accepted");
  assert.equal(pluginProblem({ ...ok, state: {} }), 'plugin "x" has a state that is not a function');
  assert.equal(pluginProblem({ ...ok, capabilities: [] }), 'plugin "x" has capabilities that are not an object');
  assert.equal(pluginProblem({ ...ok, capabilities: null }), 'plugin "x" has capabilities that are not an object');
  assert.equal(pluginProblem({ ...ok, state: () => ({}), capabilities: {} }), "", "CONTROL: both, well formed");
});
