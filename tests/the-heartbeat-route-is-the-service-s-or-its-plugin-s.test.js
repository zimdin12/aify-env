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
import { advertisementPathFor } from "../lib/plugins/index.mjs";
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
