import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { hostIdentityFacts } from "../lib/advertise.mjs";
import { ServicePlugins } from "../lib/service-plugins.mjs";
import { startDaemonPlugins } from "../lib/daemon-plugin-bootstrap.mjs";
import { pluginsForServices } from "../lib/plugins/index.mjs";
import { readServices } from "../lib/services.mjs";
import { handleRequest } from "../lib/protocol.mjs";

// Execute the actual production bootstrap statements, never import the daemon.
// Only external IO and timers are replaced. The shared payload, factory, plugin,
// starter and GET route are production code; the test never supplies machineId.
const daemon = readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
const begin = daemon.indexOf("    followServices = await startDaemonPlugins({");
const end = daemon.indexOf("\n    });", begin);
assert.ok(begin > 0 && end > begin, "production bootstrap boundaries must remain identifiable");
const bootstrap = `(async () => { let followServices; ${daemon.slice(begin, end + 8)} return followServices; })()`;

async function picker(t, facts, identity = hostIdentityFacts, context = {}) {
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
  const reports = [];
  const follow = await runInNewContext(bootstrap, {
    startDaemonPlugins, servicePlugins: registry, chr10: "\n",
    runner, VERSION: "test", REGISTRY_FILE: "memory-only-registry", CWD_ROOTS: [],
    // NO DEFINITION STORE: the daemon makes this operator's own outside the evaluated block, and a
    // picker test must never publish or read it.
    definitionStore: null,
    readFileSync: () => JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://example.invalid" } } }),
    readServices, resolvePluginCredential: async () => "test-only", logLine: () => {},
    // NO HERDR TO OPEN A SPACE IN, which is what an ordinary daemon has. What the opener does when
    // there IS one is pinned in `a-started-worker-gets-a-herdr-space.test.js`.
    paneOpener: null,
    // AN ORDINARY DAEMON, not a herdr's dedicated instance, which is what `shared.dedicated` reads.
    instanceContext: null,
    currentAdvertisementBody: () => ({ hostname: facts.hostname, kind: "test" }),
    hostIdentityFacts: identity, hostname: () => facts.hostname,
    hostIsWsl: () => facts.isWsl, existsSync: facts.exists,
    process: { platform: facts.platform, env: facts.env, stderr: { write: (line) => reports.push(line) } },
    pluginsForServices: (services, shared) => pluginsForServices(services, {
      ...shared, api, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
    }),
    ...context,
  });
  assert.equal(typeof follow, "function");
  assert.deepEqual(registry.report().map((plugin) => plugin.name), ["aify-comms"]);
  assert.ok(reports.some((line) => /hosting work for: aify-comms/.test(line)));
  assert.ok(reports.every((line) => !/failed|refused/.test(line)), "production startup reports no failed plugin");
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

test("THE DAEMON'S DEFINITION STORE AND INSTALLED HARNESSES reach the plugin it starts (P0 C3, C7)", async (t) => {
  // A store standing in for the operator's: it records who read it, and never touches a disk.
  const seen = { lists: 0, installed: null };
  const definitionStore = {
    async list() { seen.lists += 1; return { storeId: "s1", definitions: [] }; },
    async snapshot({ installed }) { seen.installed = [...installed].sort(); return { complete: false, incomplete: {} }; },
  };
  const facts = { platform: "win32", hostname: "fallback", env: { COMPUTERNAME: "Picker-Windows" }, isWsl: false, exists: () => false };
  const { answer } = await picker(t, facts, hostIdentityFacts, {
    definitionStore,
    installedHarnesses: () => [{ client: "claude" }, { client: "codex" }],
    aifyLauncherFilesOnPath: () => [],
  });
  assert.equal(answer.status, 200);
  assert.equal(seen.lists, 1, "the starter read this host's definitions");
  const deadline = Date.now() + 5000;
  while (seen.installed === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen.installed, ["claude", "codex"], "the sync was handed what this host can launch");
});
