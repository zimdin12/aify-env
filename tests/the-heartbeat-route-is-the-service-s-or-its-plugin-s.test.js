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

import {
  acceptanceKey, advertiseTo, advertisementHealth, advertisementTargets, advertisingChoice, advertisingToService,
  attemptsByService, credentialReadiness,
} from "../lib/advertise.mjs";
import { credentialReadinessFor } from "../lib/credential-resolve.mjs";
import { advertiseCredentialCheck } from "../lib/environment-checks.mjs";
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

test("a declaration that is not a path sends nothing, does not fall back to the plugin, and is reported in fixed words", async () => {
  // Odd values on purpose: a secret-looking token, control characters and markup. /health is unauthenticated and its
  // reader may be a terminal, so none of what was written may reach it -- only that it was not a path.
  const odd = "sk-live-0123\u001b[2J<script>";
  const services = registry({
    "aify-comms": { endpoint: "http://127.0.0.1:8800", advertisement: { path: `//elsewhere.invalid/${odd}` } },
    other: { endpoint: "http://127.0.0.1:9000", advertisement: `/api/v1/${odd}` },
    extra: { endpoint: "http://127.0.0.1:9100", advertisement: { path: "/beat", token: odd } },
  });
  assert.deepEqual(await onePass(services, {}), [], "a bad declaration was beaten, or replaced by the plugin's route");
  const { ignored } = advertisingChoice(services);
  assert.deepEqual(ignored, [
    "aify-comms: advertisement.path is not a valid path, no heartbeat",
    "extra: advertisement.path is not a valid path, no heartbeat",
    "other: advertisement.path is not a valid path, no heartbeat",
  ]);
  assert.doesNotMatch(ignored.join("\n"), /sk-live|script|elsewhere|\u001b/, "the declared value reached /health");
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

// ── a registry key that names an Object.prototype member is just an unknown service ────────────────────────────────
//
// A plain-object table indexed by `constructor` or `toString` returns an inherited function, and `__proto__` returns
// Object.prototype itself. Each must resolve to no plugin and no route, beside an ordinary unknown name (the control
// for "unknown") and the real aify-comms entry (the control that the pass beats at all). Raw JSON, because a JS
// object literal turns `__proto__` into a prototype instead of a key.
const PROTOTYPE_NAMES = ["__proto__", "constructor", "toString"];
const prototypeRegistry = (extra = "") => readServices(`{"version":1,"services":{${[...PROTOTYPE_NAMES, "unknown-svc"]
  .map((name) => `"${name}":{"endpoint":"http://127.0.0.1:9${name.length}00"}`).join(",")},"aify-comms":{"endpoint":"http://127.0.0.1:8800"}${extra}}}`);

test("Object.prototype names select no plugin and no route; aify-comms still does", () => {
  const services = prototypeRegistry();
  assert.deepEqual(services.map((service) => service.name), ["__proto__", "aify-comms", "constructor", "toString", "unknown-svc"],
    "the reader dropped a key, so the names below are not being asked");
  const { plugins, unserved } = pluginsForServices(services, stubContext);
  assert.deepEqual([plugins.map((plugin) => plugin.name), unserved], [["aify-comms"], [...PROTOTYPE_NAMES, "unknown-svc"]]);
  assert.deepEqual(services.map((service) => [service.name, advertisementPathFor(service)]), [
    ["__proto__", ""], ["aify-comms", "/api/v1/environments/heartbeat"], ["constructor", ""], ["toString", ""], ["unknown-svc", ""],
  ]);
});

test("Object.prototype names get no heartbeat unless they declare a path, and then exactly that one", async () => {
  assert.deepEqual((await onePass(prototypeRegistry(), {})).map((post) => [post.name, post.url]),
    [["aify-comms", "http://127.0.0.1:8800/api/v1/environments/heartbeat"]]);
  // A declaration is the service's own word whatever it is called.
  const declared = readServices('{"version":1,"services":{"constructor":{"endpoint":"http://127.0.0.1:9100","advertisement":{"path":"/beat"}}}}');
  assert.deepEqual((await onePass(declared, {})).map((post) => [post.name, post.url]), [["constructor", "http://127.0.0.1:9100/beat"]]);
});

test("a prototype-named service that declares a route is beaten once and has its own row in every /health field", async () => {
  // The daemon's own sequence: one pass, its outcomes recorded under `acceptanceKey`, then the per-service fields
  // /health serves, JSON-serialised as they travel. Assigned by index, `__proto__` replaced the object's prototype
  // and its row vanished; `constructor` and `toString` must be ordinary rows too. aify-comms is the control row.
  const services = readServices(`{"version":1,"services":{${PROTOTYPE_NAMES
    .map((name) => `"${name}":{"endpoint":"http://127.0.0.1:9${name.length}00","advertisement":{"path":"/beat"}}`)
    .join(",")},"aify-comms":{"endpoint":"http://127.0.0.1:8800"}}}`);
  const targets = advertisementTargets(advertisingChoice(services).advertised, advertisementPathFor);
  const results = await advertiseTo({ targets, body: {}, env: {}, post: async () => ({ status: 200 }) });
  const names = ["__proto__", "aify-comms", "constructor", "toString"];
  assert.deepEqual(results.map((result) => result.name), names, "each service is beaten exactly once");
  const attempts = new Map(results.map((result) => [acceptanceKey(result), { at: 1, ok: true, status: 200, error: "" }]));
  const health = advertisementHealth({ enabled: true, targets, acceptedAt: new Map(results.map((r) => [acceptanceKey(r), 1])),
    now: 1, staleMs: 10 });
  const fields = {
    advertisingTo: health.services,
    advertiseAttempts: attemptsByService(targets, attempts),
    advertiseCredentials: await credentialReadinessFor(targets, { env: {} }),
    credentialReadiness: credentialReadiness(targets, {}),
  };
  const wire = JSON.parse(JSON.stringify(fields));
  for (const [field, value] of Object.entries(wire)) {
    assert.deepEqual(Object.keys(value), names, `${field} lost a row on its way to /health`);
    assert.equal(Object.getPrototypeOf(fields[field]), Object.prototype, `${field} is not an ordinary object`);
  }
  assert.ok(names.every((name) => wire.advertisingTo[name].fresh === true));
  assert.ok(names.every((name) => advertisingToService(health, name)), "a fresh row read as not advertising");
  // The doctor reads the same fields off the wire and names every target as accepting.
  const check = advertiseCredentialCheck({ answered: true, enabled: true, credentials: wire.advertiseCredentials,
    attempts: wire.advertiseAttempts });
  assert.match(check.detail, /every target is accepting beats \(0\/4 with a credential configured\)/);
});

test("asked about a service it holds no row for, health answers no, even for a prototype name", () => {
  const health = advertisementHealth({ enabled: true, targets: [], now: 1, staleMs: 10 });
  assert.deepEqual(PROTOTYPE_NAMES.map((name) => advertisingToService(health, name)), [false, false, false]);
  // The doctor finds no row for a prototype name it is not given, rather than Object.prototype's.
  const check = advertiseCredentialCheck({ answered: true, enabled: true,
    credentials: { constructor: { keyEnv: [], hasCredential: false } }, attempts: {} });
  assert.match(check.detail, /constructor \(no beat attempted yet\)/);
});
