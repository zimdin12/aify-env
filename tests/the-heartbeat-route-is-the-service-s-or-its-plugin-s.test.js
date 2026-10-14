// Where this host's description of itself goes, now that the core names no route (0.9.7, plan D13).
//
// THE MOVE. `advertisementTargets` built `${endpoint}/api/v1/environments/heartbeat` for every registry entry, so the
// core spoke aify-comms' API to every service. The route is now the registry entry's own declaration
// (`"advertisement": {"path": "/..."}`) or its plugin's advertisement capability (`advertisementPathFor`), and a
// service with neither is sent nothing.
//
// WHAT MUST NOT MOVE is the wire to aify-comms: the same url, the same body, ONE post per beat. The literal url below
// is the contract with the aify-comms service, so it is written out here rather than derived from the code under test.

import assert from "node:assert/strict";
import test from "node:test";

import { advertiseTo, advertisementTargets, advertisingChoice } from "../lib/advertise.mjs";
import { advertisementPathFor, pluginsForServices } from "../lib/plugins/index.mjs";
import { readServices } from "../lib/services.mjs";

const WIRE = "http://127.0.0.1:8800/api/v1/environments/heartbeat";
const registry = (services) => readServices(JSON.stringify({ version: 1, services }));

/** One advertisement pass as the daemon runs it, with a post that records every call. */
async function onePass(services, body) {
  const targets = advertisementTargets(advertisingChoice(services).advertised, advertisementPathFor);
  const posts = [];
  await advertiseTo({
    targets, body, env: { AIFY_API_KEY: "k" },
    post: async (url, sent, key, name) => { posts.push({ url, sent, key, name }); return { status: 200 }; },
  });
  return posts;
}

test("aify-comms is beaten once per pass, on the same url, with the body it was given", async () => {
  const body = { hostname: "h", kind: "windows", runtimes: [], metadata: { advertiser: "aify-env" } };
  const posts = await onePass(registry({ "aify-comms": { endpoint: "http://127.0.0.1:8800/", keyEnv: ["AIFY_API_KEY"] } }), body);
  assert.equal(posts.length, 1, `one pass sent ${posts.length} heartbeats to aify-comms`);
  assert.equal(posts[0].url, WIRE, "the route aify-comms is beaten on moved");
  assert.equal(posts[0].sent, body, "the body was rebuilt or replaced on its way out");
  assert.deepEqual([posts[0].key, posts[0].name], ["k", "aify-comms"]);
});

test("a registry entry that also declares the route is still beaten once, not once per source", async () => {
  // The declaration REPLACES the plugin's route. Adding the two is the double post this move must not introduce.
  const posts = await onePass(registry({
    "aify-comms": { endpoint: "http://127.0.0.1:8800", advertisement: { path: "/api/v1/environments/heartbeat" } },
  }), {});
  assert.deepEqual(posts.map((post) => post.url), [WIRE]);
});

test("a service with no plugin route and no declaration is sent nothing; one that declares a route is", async () => {
  const posts = await onePass(registry({
    // A plugin that offers no advertisement: aify-dashboard is not an environment tracker.
    "aify-dashboard": { endpoint: "http://127.0.0.1:9700" },
    elsewhere: { endpoint: "http://127.0.0.1:9800" },
    declared: { endpoint: "http://127.0.0.1:9900", advertisement: { path: "/hosts/beat" } },
  }), {});
  // The control is the third entry: the pass does post, so the silence for the first two is the rule, not a dead pass.
  assert.deepEqual(posts.map((post) => post.url), ["http://127.0.0.1:9900/hosts/beat"]);
});

test("a declaration that is not a path sends nothing, does not fall back to the plugin, and is reported", async () => {
  const services = registry({
    "aify-comms": { endpoint: "http://127.0.0.1:8800", advertisement: { path: "//elsewhere.invalid/beat" } },
    other: { endpoint: "http://127.0.0.1:9000", advertisement: "/api/v1/environments/heartbeat" },
  });
  assert.deepEqual(await onePass(services, {}), [], "a bad declaration was beaten, or replaced by the plugin's route");
  assert.deepEqual(advertisingChoice(services).ignored, [
    'aify-comms: advertisement {"path":"//elsewhere.invalid/beat"} is not {"path": "/..."}, no heartbeat',
    'other: advertisement "/api/v1/environments/heartbeat" is not {"path": "/..."}, no heartbeat',
  ]);
});

// ── one identity rule for every decision that keys on a service (0.9.7 review) ──────────────────────────────────
//
// THE BUG. `readServices` keeps a registry key as written, and aify-wrapper's parser accepts and preserves
// `" aify-comms "`. Plugin selection trimmed the name and built the comms plugin; the route lookup did not and found no
// route, so the host description disappeared for a service whose plugin was running. Both now read `serviceIdentity`.

/** What a plugin factory needs to be BUILT, and nothing that would start it or reach a service. */
const stubContext = {
  version: "test", machineId: "win32:identity", servedElsewhere: async () => false, windows: true,
  advertisement: async () => ({}), cwdRoots: async () => [], watchRoots: async () => ({ roots: [], problems: [] }),
  definitions: { list: async () => ({ definitions: [] }), snapshot: async () => ({ complete: false, incomplete: {} }) },
  installedHarnesses: async () => new Set(),
  setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
};

for (const key of ["aify-comms", " aify-comms "]) {
  // The clean key is the control: the spaced key must be answered exactly as it is.
  test(`registry key ${JSON.stringify(key)}: the comms plugin is built AND the host description is sent once`, async () => {
    const services = registry({ [key]: { endpoint: "http://127.0.0.1:8800", keyEnv: ["AIFY_API_KEY"] } });
    assert.equal(services[0].name, key, "the reader no longer keeps the key as written, so this test proves nothing");
    const { plugins, unserved } = pluginsForServices(services, stubContext);
    assert.deepEqual([plugins.map((plugin) => plugin.name), unserved], [["aify-comms"], []], "plugin selection");
    const body = { hostname: "h", kind: "windows", runtimes: [], metadata: { advertiser: "aify-env" } };
    const posts = await onePass(services, body);
    assert.deepEqual(posts.map((post) => [post.url, post.name, post.key]), [[WIRE, "aify-comms", "k"]], "route lookup");
    assert.equal(posts[0].sent, body);
  });
}

test("an entry with a spaced key is named as the service in what /health reports", () => {
  const choice = advertisingChoice(registry({
    " aify-comms ": { endpoint: "http://127.0.0.1:8800", advertise: false },
    " other ": { endpoint: "http://127.0.0.1:9000", advertise: "no" },
  }));
  assert.deepEqual([choice.optedOut, choice.ignored], [["aify-comms"], ['other: advertise "no" ignored, advertising']]);
});
