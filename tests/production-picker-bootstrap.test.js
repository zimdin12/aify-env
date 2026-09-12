import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { hostIdentityFacts } from "../lib/advertise.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";
import { startServicePlugins } from "../lib/plugin-bootstrap.mjs";
import { pluginsForServices } from "../lib/plugins/index.mjs";
import { readServices } from "../lib/services.mjs";
import { handleRequest } from "../lib/protocol.mjs";

// Execute the actual production bootstrap statements, never import the daemon.
// Only external IO and timers are replaced. The shared payload, factory, plugin,
// starter and GET route are production code; the test never supplies machineId.
const daemon = readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
const begin = daemon.indexOf("    const host = new PluginHost({");
const end = daemon.indexOf("    for (const line of bootstrapReport(outcome))", begin);
assert.ok(begin > 0 && end > begin, "production bootstrap boundaries must remain identifiable");
const bootstrap = `(async () => { ${daemon.slice(begin, end)} return outcome; })()`;

async function picker(t, facts, identity = hostIdentityFacts) {
  const expected = hostIdentityFacts(facts).machineId;
  const agent = (machineId) => ({ machineId, sessionMode: "managed", status: "available" });
  const registry = new ServicePlugins();
  t.after(() => registry.stopAll());
  let reads = 0;
  const api = {
    heartbeat: async () => ({}), claim: async () => ({}),
    agents: async () => {
      reads++;
      return { agents: { local: agent(expected), remote: agent(`${expected}-other`), unknown: agent("") } };
    },
  };
  const runner = { list: () => [], start: () => assert.fail("listing must not spawn"),
    stop: () => assert.fail("listing must not stop a process") };
  const outcome = await runInNewContext(bootstrap, {
    PluginHost, PluginProcesses, startServicePlugins, servicePlugins: registry,
    runner, VERSION: "test", REGISTRY_FILE: "memory-only-registry", CWD_ROOTS: [],
    readFileSync: () => JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://example.invalid" } } }),
    readServices, resolvePluginCredential: async () => "test-only", logLine: () => {},
    // NO HERDR TO OPEN A SPACE IN, which is what an ordinary daemon has. What the opener does when
    // there IS one is pinned in `a-started-worker-gets-a-herdr-space.test.js`.
    paneOpener: null,
    currentAdvertisementBody: () => ({ hostname: facts.hostname, kind: "test" }),
    hostIdentityFacts: identity, hostname: () => facts.hostname,
    hostIsWsl: () => facts.isWsl, existsSync: facts.exists,
    process: { platform: facts.platform, env: facts.env },
    pluginsForServices: (services, shared) => pluginsForServices(services, {
      ...shared, api, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
    }),
  });
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(outcome.started, ["aify-comms"]);
  const answer = await handleRequest({ method: "GET", path: "/agents/startable" }, {
    runner, agents: registry.capability("agents"),
  });
  return { answer, reads };
}

for (const facts of [
  { platform: "win32", hostname: "fallback", env: { COMPUTERNAME: "Picker-Windows" }, isWsl: false },
  { platform: "linux", hostname: "Picker-WSL", env: {}, isWsl: true },
]) {
  test(`production bootstrap supplies canonical ${facts.platform}/${facts.isWsl} identity to picker`, async (t) => {
    const { answer, reads } = await picker(t, { ...facts, exists: () => false });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.problem, "", "bootstrap lost machine identity before the picker");
    assert.equal(reads, 1, "the real starter must reach the roster");
    assert.deepEqual(answer.body.agents.map((a) => a.id), ["local"], "other and unknown hosts must remain excluded");
  });
}

test("production bootstrap preserves fail-closed behavior if the identity producer cannot answer", async (t) => {
  const facts = { platform: "linux", hostname: "Picker", env: {}, isWsl: false, exists: () => false };
  const { answer, reads } = await picker(t, facts, () => ({ machineId: "" }));
  assert.match(answer.body.problem, /cannot say which machine/);
  assert.deepEqual(answer.body.agents, []);
  assert.equal(reads, 0, "missing identity must not widen the roster query");
});
