// Running the code provider's queue client for this host's projects, when they have work.
//
// ONCE A MINUTE, ONE QUESTION FIRST. The dashboard is asked which of this host's projects have calls to claim, and
// the client (aify-project-graph `scripts/serve-provider-requests.mjs`, one repository and one project per process)
// is started only for those, one at a time, in that project's watched folder. An idle host costs one request.
//
// THE CHECKOUT IS AN EXECUTION GRANT, SO IT FAILS CLOSED. `plugins["aify-dashboard"].providerCheckout` must be an
// absolute folder holding the script; anything else starts nothing and says why. A host with no queued work is not
// asked for one, so a host that never uses the provider carries no standing doctor row.
//
// ONLY A FOLDER THAT IS BOTH LISTED AND GRANTED, both read at the moment of starting: the head watcher's current
// folders, each inside the operator's grant as it stands then. One project's client can run for minutes, and a
// grant narrowed meanwhile must hold for the next one. The child's working directory is always such a folder.
//
// THE EXIT CODE IS THE CLIENT'S WHOLE ANSWER (agreed with its owner): 0 keeps the cadence; 3 tries again next
// minute; 2 (configuration) and 1 (a bug), and anything else, stop that project until its configuration section
// changes or aify-env restarts. A run past its time is killed and counts as 3, and says so once it repeats.
//
// THE KEY NEVER REACHES A DOCTOR ROW. The child is handed the dashboard key to post its answers, and what it last
// said on stderr is shown on `/health`; the key is cut out of that first.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { withinWatchRoots } from "../../watch-roots.mjs";
import { childEnv, runChild } from "./provider-child.mjs";

export const RUN_EVERY_MS = 60_000;
export const SCRIPT = join("scripts", "serve-provider-requests.mjs");
const CONFIG_KEY = 'plugins["aify-dashboard"].providerCheckout';

/** What one exit means, by the agreed codes. Anything the client does not use, or death by a signal, is a bug. */
export function outcomeOf({ code, timedOut }) {
  if (timedOut) return "retry";
  if (code === 0) return "ok";
  if (code === 3) return "retry";
  if (code === 2) return "configuration";
  return "bug";
}

/** The script to run, or why there is none. */
export function checkoutOf(config, exists = existsSync) {
  const checkout = config?.providerCheckout;
  if (checkout === undefined) return { problem: `no ${CONFIG_KEY} is set in ~/.aify/config.json` };
  if (typeof checkout !== "string" || !isAbsolute(checkout)) return { problem: `${CONFIG_KEY} must be an absolute folder, not ${JSON.stringify(checkout)}` };
  if (!exists(checkout)) return { problem: `${CONFIG_KEY} names ${checkout}, which does not exist` };
  const script = join(checkout, SCRIPT);
  if (!exists(script)) return { problem: `${checkout} has no ${SCRIPT.replace(/\\/g, "/")}` };
  return { script };
}

/** The doctor row for a project stopped by its last exit. */
function stoppedRow(projectId, latch) {
  const how = latch.outcome === "configuration" ? "exit 2 (its configuration)"
    : latch.exit === "none" ? "no exit: it could not be started" : `exit ${latch.exit} (a bug)`;
  return `project ${projectId}: the provider client stopped with ${how}; change ${CONFIG_KEY} or restart aify-env to try again${latch.said ? ` (${latch.said})` : ""}`;
}

/** Returned by `#serve` when the plugin is stopping: nothing after it is recorded. */
const STOPPING = Symbol("stopping");

export class ProviderRunner {
  #deps;
  /** projectId -> {outcome, exit, said, latchedUnder} for a project stopped by a 1 or a 2 */
  #latched = new Map();
  /** projectId -> how many runs in a row timed out */
  #timeouts = new Map();
  #problems = [];
  #runs = 0;

  /**
   * @param {object} deps
   * @param {{providerPending: Function}} deps.api
   * @param {() => Promise<string>} deps.credential  the dashboard key, resolved per run
   * @param {() => Array<{projectId: string, path: string, platform?: string}>} deps.folders  the head watcher's current folders
   * @param {() => Promise<{roots: string[]}>} deps.watchRoots
   * @param {() => {config: object|null, problem: string}} deps.config  this plugin's own config section
   * @param {string} deps.endpoint
   * @param {string} deps.hostKey
   * @param {string} deps.reporter
   * @param {Function} [deps.run]  `runChild`'s signature; injected so a test can see what was started
   * @param {object} [deps.parentEnv]
   * @param {string} [deps.nodePath]
   * @param {Function} [deps.exists]
   */
  constructor(deps) {
    this.#deps = { run: runChild, parentEnv: process.env, nodePath: process.execPath, exists: existsSync, ...deps };
  }

  /** One minute's pass. Never throws; failures become problems. */
  async pass({ signal } = {}) {
    try {
      const pending = await this.#pending(signal);
      if (pending.length === 0) {
        this.#problems = [];
        return;
      }
      const { config, problem } = this.#deps.config();
      const under = JSON.stringify(config ?? null);
      // A changed configuration section lifts every stop: the operator changed something, so it is tried again.
      for (const [projectId, latch] of this.#latched) if (latch.latchedUnder !== under) this.#latched.delete(projectId);
      const checkout = config === null ? { problem } : checkoutOf(config, this.#deps.exists);
      if (checkout.problem) {
        this.#problems = [`${pending.length} project(s) have code-provider calls queued, and none is served: ${checkout.problem}`];
        return;
      }
      const problems = [];
      for (const item of pending) {
        if (signal?.aborted) return;
        const said = await this.#serve(item, checkout.script, under, signal);
        if (said === STOPPING) return;
        if (said) problems.push(said);
      }
      this.#problems = problems;
    } catch (error) {
      if (signal?.aborted) return;
      this.#problems = [`the provider client was not run: ${error?.message || error}`];
    }
  }

  state() {
    return { runs: this.#runs, stopped: [...this.#latched.keys()], problems: [...this.#problems] };
  }

  /** Run the client once for one project, if it may run. Returns the doctor row it leaves, "" for none. */
  async #serve({ projectId, queued }, script, under, signal) {
    const d = this.#deps;
    const latch = this.#latched.get(projectId);
    if (latch) return stoppedRow(projectId, latch);

    const grant = await d.watchRoots();
    if (!Array.isArray(grant?.roots)) throw new Error("this aify-env's watch roots could not be read");
    const folder = d.folders().find((f) => f.projectId === projectId && withinWatchRoots(f.path, grant.roots, f.platform));
    if (!folder) return `project ${projectId} has ${queued} code-provider call(s) queued, and no watched, granted folder here to serve them from`;

    const key = String((await d.credential()) || "");
    if (!key) return `project ${projectId}: no credential for aify-dashboard on this host, so the provider client was not started`;
    const env = childEnv(d.parentEnv, {
      APG_DASHBOARD_URL: d.endpoint, APG_DASHBOARD_KEY: key, APG_DASHBOARD_PROJECT: projectId,
      APG_DASHBOARD_HOST: d.hostKey, APG_DASHBOARD_REPORTER: d.reporter,
    });
    const result = await d.run({ nodePath: d.nodePath, script, cwd: folder.path, env, signal });
    if (result.stopped || signal?.aborted) return STOPPING;
    this.#runs += 1;

    const outcome = outcomeOf(result);
    if (outcome === "configuration" || outcome === "bug") {
      const stopped = { outcome, exit: result.code ?? result.signal ?? "none", said: result.error.split(key).join("<the dashboard key>"), latchedUnder: under };
      this.#latched.set(projectId, stopped);
      return stoppedRow(projectId, stopped);
    }
    if (!result.timedOut) {
      this.#timeouts.delete(projectId);
      return "";
    }
    const count = (this.#timeouts.get(projectId) ?? 0) + 1;
    this.#timeouts.set(projectId, count);
    return count >= 2 ? `project ${projectId}: the provider client ran past its time ${count} times in a row and was stopped` : "";
  }

  /** The dashboard's answer, checked: a malformed one is a failure, never "nothing queued". */
  async #pending(signal) {
    const d = this.#deps;
    const body = await d.api.providerPending(d.hostKey, { signal });
    if (!body || body.hostKey !== d.hostKey || !Array.isArray(body.projects)
      || !body.projects.every((p) => typeof p?.projectId === "string" && Number.isSafeInteger(p?.queued) && p.queued > 0)) {
      throw new Error("the dashboard's answer about queued provider calls was not the shape it should be");
    }
    return body.projects;
  }
}
