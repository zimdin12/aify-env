// A registry entry's name chooses its plugin factory. Only the names the factory map itself holds may: a name that
// is a property every object inherits is a service nobody here serves.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pluginsForServices } from "../lib/plugins/index.mjs";

test("a registry name that is only an Object property builds no plugin", () => {
  // The bug: the factory looked up with map[name], so an entry named "constructor" was built by Object().
  const { plugins, unserved } = pluginsForServices([{ name: "constructor", endpoint: "http://a" }, { name: "toString", endpoint: "http://b" }]);
  assert.deepEqual(plugins, []);
  assert.deepEqual(unserved, ["constructor", "toString"]);
});
