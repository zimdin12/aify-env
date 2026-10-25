// File activity for a worker this host starts from a definition (aify-dashboard #52). A definition cannot name an
// AIFY_* variable, so the aify-dashboard plugin contributes AIFY_FILE_ACTIVITY itself, through a second spawnEnv offer,
// when its `activity` grant is enabled and `activity.managed` covers the agent. The secrets offer is unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";

import { activityContributor } from "../lib/plugins/aify-dashboard/activity-contributor.mjs";
import { createDashboardPlugin } from "../lib/plugins/aify-dashboard/index.mjs";
import { spawnEnvFor } from "../lib/plugins/aify-comms/spawn-env.mjs";
import { ServicePlugins } from "../lib/service-plugins.mjs";

const GRANT = { enabled: true, leaseDirectory: "C:/lease", wrapperCheckout: "C:/wrapper" };
const configured = (activity) => () => ({ config: activity === undefined ? {} : { activity }, problem: "" });
const signal = new AbortController().signal;
const ask = (offer, definition = { id: "lead", env: {} }) => offer.contribute({ definition, signal });
const ON = { env: { AIFY_FILE_ACTIVITY: "1" } };
const NOTHING = { env: {} };

test("managed true contributes the switch to every defined start", async () => {
  assert.deepEqual(await ask(activityContributor({ config: configured({ ...GRANT, managed: true }) })), ON);
});

test("a list of ids contributes to a listed agent and to no other", async () => {
  const offer = activityContributor({ config: configured({ ...GRANT, managed: ["lead", "coder"] }) });
  assert.deepEqual(await ask(offer, { id: "coder", env: {} }), ON);
  assert.deepEqual(await ask(offer, { id: "reviewer", env: {} }), NOTHING);
});

test("nothing is contributed unless the grant is enabled and managed says yes", async () => {
  for (const activity of [undefined, { ...GRANT, enabled: false, managed: true }, GRANT, { ...GRANT, managed: false },
    { ...GRANT, managed: "yes" }, { ...GRANT, managed: [1] }, { ...GRANT, managed: [] }]) {
    assert.deepEqual(await ask(activityContributor({ config: configured(activity) })), NOTHING, JSON.stringify(activity));
  }
});

test("a malformed grant or an unreadable configuration contributes nothing and refuses no start", async () => {
  const malformed = activityContributor({ config: configured({ enabled: true, managed: true, leaseDirectory: "relative" }) });
  assert.deepEqual(await ask(malformed), NOTHING);
  const throwing = activityContributor({ config: () => { throw new Error("unreadable"); } });
  assert.deepEqual(await ask(throwing), NOTHING);
  const problem = activityContributor({ config: () => ({ config: null, problem: "no configuration" }) });
  assert.deepEqual(await ask(problem), NOTHING);
});

test("the grant's bounds travel with the switch, so the producer and the shipper hold one policy", async () => {
  const offer = activityContributor({ config: configured({ ...GRANT, managed: true, sessionBytes: 65536, maxSessions: 4, maxAgeMs: 3600000 }) });
  assert.deepEqual(await ask(offer), { env: { AIFY_FILE_ACTIVITY: "1", AIFY_ACTIVITY_SESSION_BYTES: "65536",
    AIFY_ACTIVITY_MAX_SESSIONS: "4", AIFY_ACTIVITY_MAX_AGE_MS: "3600000" } });
});

test("a capability offered as an array is counted offer by offer, and an object capability is unchanged", async () => {
  const registry = new ServicePlugins();
  const first = { service: "one", contribute: async () => NOTHING };
  const second = { service: "one", contribute: async () => NOTHING };
  const agents = { list: async () => [] };
  const plugin = (name, capabilities) => ({ name, capabilities, state: () => ({}), start: async () => {}, stop: async () => {} });
  assert.deepEqual(await registry.add(plugin("many", { spawnEnv: [first, second], agents }), {}), {});
  assert.deepEqual(await registry.add(plugin("single", { spawnEnv: first }), {}), {});
  assert.deepEqual(registry.capabilities("spawnEnv"), [first, second, first]);
  assert.deepEqual(registry.capabilities("agents"), [agents]);
});

test("the plugin offers the secrets contributor first and the activity contributor beside it", () => {
  const plugin = createDashboardPlugin({ endpoint: "http://127.0.0.1:1", config: configured({ ...GRANT, managed: true }) });
  const offers = plugin.capabilities.spawnEnv;
  assert.ok(Array.isArray(offers) && offers.length === 2);
  assert.equal(offers[0].field, "secrets");
  assert.equal(Object.hasOwn(offers[1], "field"), false, "the activity offer supplies no definition field");
});

test("a defined start gets the switch, and a launch that sets it itself is refused, not overridden", async () => {
  const offer = activityContributor({ config: configured({ ...GRANT, managed: true }) });
  const definitionFor = async () => ({ agent: { id: "lead", env: {} } });
  const launch = (env = {}) => ({ agentId: "lead", definition: { storeId: "s", incarnation: "i", revision: 1 }, env });
  const started = await spawnEnvFor({ launch: launch(), env: { PATH: "p" }, contributors: [offer], definitionFor, windows: true });
  assert.equal(started.env?.AIFY_FILE_ACTIVITY, "1");
  const collided = await spawnEnvFor({ launch: launch({ AIFY_FILE_ACTIVITY: "0" }), env: { AIFY_FILE_ACTIVITY: "0" }, contributors: [offer], definitionFor, windows: true });
  assert.match(collided.refused ?? "", /collides with a variable the launch sets/);
  const bare = await spawnEnvFor({ launch: { agentId: "lead", env: {} }, env: { PATH: "p" }, contributors: [offer], definitionFor, windows: true });
  assert.equal(Object.hasOwn(bare.env, "AIFY_FILE_ACTIVITY"), false, "a start from no definition is not asked");
});
