// The plugin interface: what the host gives a service plugin, and what a plugin must be (0.9 plan P0 C10).
//
// TWO PHASES, as the host has always run them. A factory in `FACTORIES` (index.mjs) is called with the shared
// context and the plugin's own registry entry, and returns a plugin; `start(host)` is then called with a
// `PluginHost` (service-plugins.mjs). This file states both shapes so a plugin is written against a contract, not
// against whatever the comms plugin happens to read, and `pluginProblem` in service-plugins.mjs refuses one that
// does not meet it. tests/every-plugin-meets-the-interface.test.js builds every factory's product and checks it.
//
// Nothing here runs: the typedefs are the contract, and the conformance test is its proof.

/**
 * What every factory is handed (bin/aify-env.mjs builds it once per daemon).
 *
 * @typedef {object} SharedContext
 * @property {string} version                  this aify-env's version
 * @property {string} machineId                `<platform or wsl>:<host>`, lowercased (machineIdFor)
 * @property {boolean} dedicated               a herdr's dedicated instance: a once-per-host plugin declines here
 * @property {() => Promise<object>} advertisement   what this host advertises, read when asked
 * @property {() => Promise<string[]>} cwdRoots      where launches may run
 * @property {() => Promise<{roots: string[], problems: string[]}>} watchRoots   what a plugin may read (a grant)
 * @property {boolean} windows
 * @property {object} definitions              the DefinitionStore (list, snapshot, applyRequest, admitStart)
 * @property {() => Promise<Set<string>>} installedHarnesses
 * @property {string} endpoint                 the plugin's own service endpoint
 * @property {object} service                  the plugin's own registry entry
 */

/**
 * What `start(host)` is handed (service-plugins.mjs `PluginHost`).
 *
 * @typedef {object} PluginHostPorts
 * @property {object} processes                start, stop and list the PTY processes this plugin owns
 * @property {string} environmentId
 * @property {(entry: object) => Promise<string>} credential   the key for this plugin's own entry, resolved per call
 * @property {(line: string) => void} log
 */

/**
 * What a plugin must be.
 *
 * @typedef {object} ServicePlugin
 * @property {string} name                     the registry name it serves
 * @property {(host: PluginHostPorts) => Promise<void>} start
 * @property {() => Promise<void>} stop        safe before start and safe twice
 * @property {() => {problems?: string[]}} [state]   what a doctor reads: an object; `problems`, when present, an array
 *                                             of strings; the optional keys `claimer` and `definitions` mark the
 *                                             plugins those checks consider
 * @property {Object<string, object>} [capabilities] what it offers the host, by name (e.g. `agents`)
 */

/** @typedef {(context: SharedContext) => ServicePlugin} PluginFactory */

export {};
