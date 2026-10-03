// Each service plugin reads its own section of ~/.aify/config.json, `plugins["<registry name>"]`, through a reader
// the host binds to that name. The host knows nothing of what is in a section. Nothing here reads the real ~/.aify:
// the binding is checked with an injected reader (`shared.readPluginConfig`), and the file reader with a scratch home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hostConfigPath } from "../lib/host-config.mjs";
import { pluginConfigFrom, readPluginConfig } from "../lib/plugin-config.mjs";
import { factoryArguments } from "../lib/plugins/index.mjs";

test("each plugin's reader asks for its own registry name, on every call", () => {
  // The bugs: every plugin handed one section (or the whole file), or a section read once at build time, so an
  // edited config needs a restart to reach a running plugin.
  const reads = [];
  const readPluginConfig = ({ name }) => { reads.push(name); return { config: { for: name }, problem: "" }; };
  const built = [{ name: "aify-comms", endpoint: "http://a" }, { name: "aify-dashboard", endpoint: "http://b" }]
    .map((service) => factoryArguments(service, { readPluginConfig }));
  assert.deepEqual(reads, [], "nothing is read while building");
  assert.deepEqual(built.map((args) => args.config().config.for), ["aify-comms", "aify-dashboard"]);
  built[0].config();
  assert.deepEqual(reads, ["aify-comms", "aify-dashboard", "aify-comms"]);
});

test("a section is an object under plugins[name]; anything else is no section, with the reason", () => {
  // The bug: a malformed file or section read as a configuration, when a plugin may treat a value in it as a grant.
  const rows = [
    ["", /does not exist or is empty/],
    ["{ not json", /is not JSON/],
    ["{}", /has no plugins\["svc"\] section/],
    ['{"plugins": []}', /has no plugins\["svc"\] section/],
    ['{"plugins": {"other": {}}}', /has no plugins\["svc"\] section/],
    ['{"plugins": {"svc": [1]}}', /plugins\["svc"\] in ~\/\.aify\/config\.json is not an object/],
    ['{"plugins": {"svc": "x"}}', /is not an object/],
    ['{"plugins": {"svc": null}}', /is not an object/],
  ];
  for (const [text, why] of rows) {
    const read = pluginConfigFrom(text, "svc");
    assert.equal(read.config, null, text);
    assert.match(read.problem, why, text);
  }
  assert.deepEqual(pluginConfigFrom('{"plugins": {"svc": {"a": 1}, "other": {"b": 2}}}', "svc"), { config: { a: 1 }, problem: "" });
});

test("the file is read from the home it is given, and a missing one is no section", () => {
  const home = mkdtempSync(join(tmpdir(), "aify-plugin-config-"));
  assert.match(readPluginConfig({ name: "svc", home }).problem, /does not exist or is empty/);
  const file = hostConfigPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ plugins: { svc: { providerCheckout: "C:/apg" } } }));
  assert.deepEqual(readPluginConfig({ name: "svc", home }), { config: { providerCheckout: "C:/apg" }, problem: "" });
});
