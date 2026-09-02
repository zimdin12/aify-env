// Service plugins: how a service teaches this host to talk to it, without this host learning about it.
//
// WHY THIS EXISTS. aify-env spawns processes, owns their PTYs, streams their output and reaps them.
// None of that is specific to any service. But claiming a spawn request, polling for dispatches and
// reporting terminal state ARE specific to aify-comms -- and until 2026-09-02 they lived in a
// separate process (`aify-comms`, the environment bridge), which is why spawning needed a second
// command running beside this one. The operator's framing settled the design: "aify-env is a general
// thing, not actually for aify-comms. it is more like interface for aify-comms to use."
//
// So the split is by KNOWLEDGE, not by size: a module that names a service's endpoint is that
// service's, and everything else is this host's. Measured on the bridge that day, 2,717 lines were
// generic and 1,023 knew about aify-comms -- 73% of what everyone called "the aify-comms bridge" was
// general host capability that a second `aify-` service would need identically.
//
// THE INTERFACE IS DELIBERATELY NARROW, and shaped by its first consumer rather than by what a host
// could imagine offering. A plugin gets process control, its own credential, this environment's
// identity, and a log. It does NOT get the Runner itself: the registry, the shutdown chain and the
// advertisement are this host's, and a plugin reaching them could supersede or reap work it does not
// own -- which is the failure this project has already had twice from the other direction.

/**
 * What a plugin may do to processes. A NARROWED VIEW of the Runner, not the Runner.
 *
 * Every method here is one the comms plugin actually needs; nothing is added because it might be
 * wanted. A wider surface is not free -- it is the set of things a future plugin can break.
 *
 * PURE PASS-THROUGH BY CONSTRUCTION: this holds no state of its own, so there is no second place
 * where a process's liveness is recorded and no chance of the two disagreeing.
 */
export class PluginProcesses {
  #runner;

  constructor(runner) {
    if (!runner || typeof runner.start !== "function") {
      throw new TypeError("PluginProcesses needs a Runner");
    }
    this.#runner = runner;
  }

  /** Start a process. Resolves to the record the Runner made for it. */
  async start(spec) { return this.#runner.start(spec); }

  /** Watch a process's output and its exit. Returns whatever unsubscribe the Runner gives. */
  subscribe(id, onOutput, onExit) { return this.#runner.subscribe(id, onOutput, onExit); }

  /** True when this process has a stream to subscribe to at all. */
  canStream(id) { return this.#runner.canStream(id); }

  /** Send input to a process's terminal. */
  write(id, data) { return this.#runner.write(id, data); }

  /** Resize a process's terminal. */
  resize(id, cols, rows) { return this.#runner.resize(id, cols, rows); }

  /** Stop a process this plugin started. */
  async stop(id, options = {}) { return this.#runner.stop(id, options); }

  /** Rename a process, so a host list reads in the service's terms rather than the launcher's. */
  relabel(id, label) { return this.#runner.relabel(id, label); }

  /** Everything running here, including processes other plugins own. READ ONLY by construction. */
  list() { return this.#runner.list(); }
}

/**
 * What one service plugin is handed. Explicit in, explicit out -- nothing is reached for globally.
 *
 * `credential` is a FUNCTION rather than a value because a key can be rotated while this host runs,
 * and a plugin that captured a string at start would keep presenting the old one until restarted.
 * That is exactly the shape that cost a day on 2026-09-02: a credential was stored, and the process
 * that needed it had read its absence at boot and never looked again.
 */
export class PluginHost {
  constructor({ processes, environmentId = "", credential = async () => "", log = () => {} } = {}) {
    if (!(processes instanceof PluginProcesses)) {
      throw new TypeError("PluginHost needs a PluginProcesses");
    }
    this.processes = processes;
    this.environmentId = String(environmentId || "");
    this.credential = credential;
    this.log = log;
  }
}

/** A plugin is REFUSED unless it declares all three. A half-declared plugin fails at teardown, in
 *  the dark, holding processes nothing will now reap. */
export function pluginProblem(plugin) {
  if (!plugin || typeof plugin !== "object") return "not an object";
  if (typeof plugin.name !== "string" || !plugin.name.trim()) return "no name";
  if (typeof plugin.start !== "function") return `plugin "${plugin.name}" has no start()`;
  if (typeof plugin.stop !== "function") return `plugin "${plugin.name}" has no stop()`;
  return "";
}

/**
 * The plugins this host is running, and their lifecycle.
 *
 * ONE FAILING PLUGIN MUST NOT TAKE THE HOST DOWN. aify-env's own job -- running processes for
 * whoever asked -- does not depend on any service being reachable, and a host that dies because one
 * service's API is down would take every running agent with it. So `startAll` isolates each start
 * and reports what failed rather than throwing.
 *
 * STOP IS BEST-EFFORT AND ALWAYS COMPLETE. Every plugin is stopped even if an earlier one throws;
 * a teardown that abandons the rest at the first error is how processes outlive the thing that owned
 * them.
 */
export class ServicePlugins {
  #plugins = [];
  #started = [];

  /** @returns {string} a reason it was refused, or "" when registered. */
  register(plugin) {
    const problem = pluginProblem(plugin);
    if (problem) return problem;
    if (this.#plugins.some((p) => p.name === plugin.name)) {
      return `a plugin named "${plugin.name}" is already registered`;
    }
    this.#plugins.push(plugin);
    return "";
  }

  names() { return this.#plugins.map((p) => p.name); }

  /** @returns {Array<{name: string, error: Error}>} the ones that failed to start. */
  async startAll(host) {
    const failures = [];
    for (const plugin of this.#plugins) {
      try {
        await plugin.start(host);
        this.#started.push(plugin);
      } catch (error) {
        failures.push({ name: plugin.name, error });
      }
    }
    return failures;
  }

  /** @returns {Array<{name: string, error: Error}>} the ones that failed to stop. */
  async stopAll() {
    const failures = [];
    // Reverse order: a plugin started later may depend on one started earlier, and tearing down in
    // registration order would pull the ground from under it.
    for (const plugin of [...this.#started].reverse()) {
      try {
        await plugin.stop();
      } catch (error) {
        failures.push({ name: plugin.name, error });
      }
    }
    this.#started = [];
    return failures;
  }
}
