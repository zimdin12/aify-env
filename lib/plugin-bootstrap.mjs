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
