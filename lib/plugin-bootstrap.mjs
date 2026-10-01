// Starting the service plugins: the CALL, not just the pieces it calls.
//
// WHY THIS IS A MODULE AND NOT SIX LINES IN THE DAEMON. `bin/aify-env.mjs` cannot be imported to
// test -- importing it STARTS the environment, which supersedes the one already serving and reaps
// its managed workers. That has cost this project a live fleet more than once. So anything in the
// daemon that can fail is only ever proven by running the daemon, which nobody does in a test.
//
// The sibling repo learned the same thing and wrote it down: a predicate proven in isolation leaves
// the CALL to it unproven, and that is exactly where one of its checks failed -- an early return
// answered a case itself and never consulted the verdict it was built around. This file is the call.

/**
 * Register and start a plugin for every registered service this host can serve.
 *
 * NOTHING HERE THROWS. This host runs processes for whoever asked, and that job does not depend on
 * any service being reachable -- a daemon that died because one service was down would take every
 * running agent with it. Every failure is returned for the caller to report.
 *
 * @returns {{started: string[], refused: string[], failed: Array<{name: string, error: any}>, unserved: string[]}}
 */
export async function startServicePlugins({
  registry,          // ServicePlugins
  host,              // PluginHost
  services = [],     // registry entries: {name, endpoint}
  build,             // (services, shared) => {plugins, unserved}
  shared = {},
} = {}) {
  const refused = [];
  let plugins = [];
  let unserved = [];
  try {
    ({ plugins, unserved } = build(services, shared));
  } catch (error) {
    // A registry this host cannot read is not a reason to stop running processes for the ones it
    // already started. It IS a reason to say so.
    return { started: [], refused: [], failed: [{ name: "(registry)", error }], unserved: [] };
  }

  for (const plugin of plugins) {
    const problem = registry.register(plugin);
    if (problem) refused.push(problem);
  }

  const failed = plugins.length ? await registry.startAll(host) : [];
  const failedNames = new Set(failed.map((f) => f.name));
  const started = registry.names().filter((name) => !failedNames.has(name));
  return { started, refused, failed, unserved };
}

/**
 * What a registry change asks of the running plugins (P0 C8). PURE.
 *
 * A plugin whose service is gone, or now named at another endpoint, detaches. A service is added
 * only when no plugin of its name stays: after an endpoint change, the new plugin waits until the old
 * one has let go, which it does only once it serves no workers.
 *
 * @param {Array<{name: string, endpoint: string}>} running what `ServicePlugins.running()` reports
 * @param {Array<{name: string, endpoint: string}>} services what the registry names
 * @returns {{detach: string[], add: Array<object>}}
 */
export function planPluginChanges(running, services) {
  const named = new Map(services.map((service) => [service.name, service]));
  const detach = running.filter((plugin) => named.get(plugin.name)?.endpoint !== plugin.endpoint).map((plugin) => plugin.name);
  const staying = new Set(running.map((plugin) => plugin.name).filter((name) => !detach.includes(name)));
  return { detach, add: services.filter((service) => service.endpoint && !staying.has(service.name)) };
}

/**
 * Bring the running plugins level with the registry. Called on every advertiser beat with a registry
 * that was READ; an unreadable one changes nothing, since unreadable is not "no services".
 *
 * STATE, NOT EVENTS: a plugin still holding workers is simply planned for detach again on the next
 * call, and detaches once its last worker has ended. Nothing here throws; everything is returned.
 *
 * @returns {Promise<{added: string[], detached: string[], held: Array<{name: string, held: number}>, resumed: string[], failed: string[]}>}
 */
export async function followRegistry({ registry, host, services = [], build, shared = {} } = {}) {
  const plan = planPluginChanges(registry.running(), services);
  const outcome = { added: [], detached: [], held: [], resumed: [], failed: [] };
  // A plugin the plan leaves in place resumes if it was held: the change that held it was undone.
  for (const { name } of registry.running()) {
    if (!plan.detach.includes(name) && registry.resume(name)) outcome.resumed.push(name);
  }
  for (const name of plan.detach) {
    const result = await registry.detach(name);
    if (result.detached) outcome.detached.push(name);
    else outcome.held.push({ name, held: result.held, ...(result.problem ? { problem: result.problem } : {}) });
  }
  const taken = new Set(registry.names());
  for (const service of plan.add) {
    if (taken.has(service.name)) continue;
    let plugins = [];
    try { ({ plugins } = build([service], shared)); } catch (error) { outcome.failed.push(`${service.name}: ${error?.message || error}`); continue; }
    if (plugins.length === 0) continue;
    const result = await registry.add(plugins[0], host);
    if (result.problem || result.error) outcome.failed.push(`${service.name}: ${result.problem || result.error?.message || result.error}`);
    else outcome.added.push(service.name);
  }
  return outcome;
}

/**
 * Lines for the daemon's log about one registry follow, or none when nothing changed. PURE.
 * A plugin still held is not repeated here on every beat: it says so itself, once, when it becomes
 * held, and its state (`phase: "held"`, `heldWorkers`) is what /health and the doctor read.
 */
export function followReport({ added = [], detached = [], resumed = [], failed = [] } = {}) {
  return [
    ...added.map((name) => `registry: started the plugin for ${name}`),
    ...resumed.map((name) => `registry: resumed the plugin for ${name}`),
    ...detached.map((name) => `registry: detached the plugin for ${name}`),
    ...failed.map((line) => `registry: could not start a plugin: ${line}`),
  ];
}

/**
 * What the daemon should print about that, in the operator's terms.
 *
 * SILENCE IS THE FAILURE THIS ANSWERS. On 2026-09-02 a service was registered, its row read
 * `online`, every spawn was refused, and no component said why -- because nothing was responsible
 * for saying "registered, and nothing here hosts its work". Each line below exists because its
 * absence cost hours.
 *
 * PURE: returns lines, writes nothing. The daemon owns its own stderr.
 */
export function bootstrapReport({ started = [], refused = [], failed = [], unserved = [] } = {}) {
  const lines = [];
  for (const problem of refused) lines.push(`plugin refused: ${problem}`);
  for (const failure of failed) {
    lines.push(`plugin "${failure.name}" failed to start: ${failure.error?.message || failure.error}`);
  }
  if (unserved.length) {
    lines.push(`registered but no plugin to host their work: ${unserved.join(", ")}`);
  }
  if (started.length) lines.push(`hosting work for: ${started.join(", ")}`);
  return lines;
}

/**
 * The KEY for a service, out of the resolution its resolver returns.
 *
 * WHY THIS IS A FUNCTION AND NOT ONE LINE IN THE DAEMON. `credentialForTarget` answers with
 * `{state, value, source, detail, ref}` -- a RESOLUTION, not a key. The daemon's plugin resolver
 * returned the whole object, so `[object Object]` went into the `X-API-Key` header and every
 * heartbeat was refused with 401, while the advertiser forty lines below -- which does take
 * `.value` -- kept working. Two callers of one function, one of them wrong, and the symptom was
 * indistinguishable from having no credential at all.
 *
 * It lived in `bin/aify-env.mjs`, which cannot be imported without STARTING the environment, so
 * nothing could test it and the defect was found by running against a live service. That is the
 * argument for this module existing: anything in the daemon that can be wrong should not be there.
 *
 * @param {object|null} resolution what `credentialForTarget` returned
 * @returns {string} the key, or "" -- never an object, and never "undefined"
 */
export function credentialValue(resolution) {
  const value = resolution && typeof resolution === "object" ? resolution.value : resolution;
  return typeof value === "string" ? value : "";
}
