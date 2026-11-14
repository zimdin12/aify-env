// One serial APG worker per host/endpoint. Env owns claims, results and service credentials.
// Pending long-polls wait25s; old/immediate/error servers and transient worker exits back off60s.
// Each feed rechecks the watched real-path grant. APG refuses non-top-level roots, never widens them.
// Worker exits1/2/signals latch the endpoint; owned90s timeouts retry. In-band refusals do not end it.
// runChild remains the sole process/cleanup owner, also used unchanged by the independent sweep.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { withinWatchRoots } from "../../watch-roots.mjs";
import { realRoots } from "./grant-check.mjs";
import { childEnv, runChild } from "./provider-child.mjs";
import { ProviderWorker } from './provider-worker.mjs';

export const RUN_EVERY_MS = 60_000;
export const SCRIPT = join("bin", "apg.js");
export const CONFIG_KEY = 'plugins["aify-dashboard"].providerCheckout';

/** What one exit means, by the agreed codes. Anything the client does not use, or death by a signal, is a bug. */
export function outcomeOf({ code, timedOut, protocolError }) {
  if (protocolError) return 'bug';
  if (timedOut) return "retry";
  if (code === 0) return "ok";
  if (code === 3) return "retry";
  if (code === 2) return "configuration";
  return "bug";
}

/** The script to run, or why there is none. The sweep client lives in the same checkout (sweep-runner.mjs). */
export function checkoutOf(config, exists = existsSync, scriptPath = SCRIPT) {
  const checkout = config?.providerCheckout;
  if (checkout === undefined) return { problem: `no ${CONFIG_KEY} is set in ~/.aify/config.json` };
  if (typeof checkout !== "string" || !isAbsolute(checkout)) return { problem: `${CONFIG_KEY} must be an absolute folder, not ${JSON.stringify(checkout)}` };
  if (!exists(checkout)) return { problem: `${CONFIG_KEY} names ${checkout}, which does not exist` };
  const script = join(checkout, scriptPath);
  if (!exists(script)) return { problem: `${checkout} has no ${scriptPath.replace(/\\/g, "/")}` };
  return { script };
}

/**
 * Whether a watched folder of `projectId` may have a client started in it under the grant as it stands now: its listed
 * path and the real folder its look judged both inside, the second by the roots' own real paths.
 */
export function servableNow(folder, projectId, roots, { realpath }) {
  return folder.projectId === projectId
    && withinWatchRoots(folder.path, roots, folder.platform)
    && withinWatchRoots(folder.real, realRoots(roots, { realpath, platform: folder.platform }), folder.platform);
}

/** The doctor row for a project stopped by its last exit. */
function stoppedRow(projectId, latch) {
  const how = latch.outcome === "configuration" ? "exit 2 (its configuration)"
    : latch.exit === "none" ? "no exit: it could not be started" : `exit ${latch.exit} (a bug)`;
  return `provider for ${projectId}: the provider client stopped with ${how}; change ${CONFIG_KEY} or restart aify-env to try again${latch.said ? ` (${latch.said})` : ""}`;
}

/**
 * The rows saying a provider client's process tree was not confirmed ended: one per project of one dashboard, its
 * latest. Whoever owns it decides how long they are kept; the plugin keeps one for the whole aify-env process
 * (index.mjs).
 *
 * ⛔ A PROJECT IS ITS DASHBOARD AND ITS ID. One process can serve two dashboards in turn, and an id from each is not one
 * project: kept by id alone, the second's row replaced the first's (review of de1a942, F3-N1). The pair is kept as
 * JSON, so no character in either half can run two pairs together.
 */
export class CleanupWarnings {
  #rows = new Map();

  /** `client` is which of the plugin's clients it was, so the queue client's row and the sweep's for one project are two. */
  note(endpoint, projectId, row, client = "provider") {
    this.#rows.set(JSON.stringify([endpoint, projectId, client]), row);
  }

  rows() {
    return [...this.#rows.values()];
  }
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
  #worker = null; #scope = ''; #dueAt = 0; #closing = Promise.resolve();
  delayMs = RUN_EVERY_MS;

  async close() {
    const worker = this.#worker; this.#worker = null;
    if (worker) this.#closing = worker.close();
    await this.#closing;
  }

  async reconcile() {
    if (!this.#worker) return;
    try {
      const grant = await this.#deps.watchRoots();
      if (!Array.isArray(grant?.roots)) throw Error('unknown grant');
      const scope = JSON.stringify([this.#deps.config().config, grant.roots]);
      if (scope === this.#scope) return;
    } catch { /* An unreadable grant cannot keep a worker. */ }
    await this.close();
  }

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
   * @param {(path: string) => string} [deps.realpath]  how a granted root resolves to the folder it really is
   * @param {CleanupWarnings} [deps.cleanupWarnings]  where a kill not confirmed is kept; this runner's own by default
   */
  constructor(deps) {
    this.#deps = { run: runChild, worker: parts => new ProviderWorker(parts), now: Date.now, parentEnv: process.env, nodePath: process.execPath, exists: existsSync, realpath: realpathSync.native, cleanupWarnings: new CleanupWarnings(), ...deps };
  }

  /** One minute's pass. Never throws; failures become problems. */
  async pass({ signal } = {}) {
    try {
      await this.reconcile();
      if (signal?.aborted) return;
      if (this.#dueAt > this.#deps.now()) { this.delayMs = this.#dueAt - this.#deps.now(); return; }
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
      this.delayMs = RUN_EVERY_MS;
      this.#problems = [`the provider client was not run: ${error?.message || error}`];
    }
  }

  state() {
    return { runs: this.#runs, stopped: [...this.#latched.keys()], problems: [...new Set([...this.#problems,
      ...[...this.#latched].map(([key, latch]) => stoppedRow(key, latch)), ...this.#deps.cleanupWarnings.rows()])] };
  }

  /** Run the client once for one project, if it may run. Returns the doctor row it leaves, "" for none. */
  async #serve({ projectId, queued }, script, under, signal) {
    const d = this.#deps;
    const latch = this.#latched.get(d.endpoint);
    if (latch) { this.delayMs = RUN_EVERY_MS; return stoppedRow(d.endpoint, latch); }
    const key = String((await d.credential()) || "");
    if (!key) return `project ${projectId}: no credential for aify-dashboard on this host, so the provider client was not started`;
    const claimed = await d.api.claimProvider(d.hostKey, projectId, { signal });
    if (!Array.isArray(claimed?.claimed) || claimed.claimed.length > 1 || claimed.claimed.some(r =>
      r?.projectId !== projectId || typeof r.requestId !== 'string' || !r.requestId || typeof r.call !== 'string' || !r.call
      || !r.args || typeof r.args !== 'object' || Array.isArray(r.args))) throw Error('invalid provider claim');
    const request = claimed.claimed[0];
    if (!request) { this.delayMs = RUN_EVERY_MS; return ''; }
    let grant = await d.watchRoots();
    if (!Array.isArray(grant?.roots)) throw new Error("this aify-env's watch roots could not be read");
    const scope = JSON.stringify([d.config().config, grant.roots]);
    if (scope !== this.#scope || !this.#worker) {
      await this.close();
      grant = await d.watchRoots();
      if (!Array.isArray(grant?.roots)) throw new Error("this aify-env's watch roots could not be read");
    }
    // A folder with no judged real path was never judged, and is not served: `withinWatchRoots` refuses anything that is
    // not a path, so the check of the real folder below is that refusal too. The grant as it stands now must reach
    // both the listed path and the real folder the client runs in, the second judged as the watcher judges it, by the
    // roots' own real paths: a listed junction that is still inside a narrowed grant can lead to a folder that no
    // longer is (review of 8e7a638, P2-G1), and a granted root that is a junction must still serve what it leads to.
    const folder = d.folders().find((f) => servableNow(f, projectId, grant.roots, { realpath: d.realpath }));
    if (!folder || JSON.stringify(d.config().config ?? null) !== under) {
      const problem = `project ${projectId} has ${queued} code-provider call(s) queued, and no watched, granted folder here to serve them from`;
      await d.api.postProviderResult(d.hostKey, request.requestId, { ok: false, problem }, { signal });
      return problem;
    }
    if (signal?.aborted) return STOPPING;
    this.#scope = JSON.stringify([d.config().config, grant.roots]);
    if (!this.#worker) {
      const worker = d.worker({ nodePath: d.nodePath, script, cwd: folder.real, env: childEnv(d.parentEnv, {}), key, run: d.run });
      this.#worker = worker;
      worker.done.then(result => {
        if (result.unconfirmed) d.cleanupWarnings.note(d.endpoint, 'host', `provider for ${d.endpoint}: ${result.unconfirmed.split(key).join('<the dashboard key>')}; its processes may still be running`);
        if (this.#worker !== worker) return;
        this.#worker = null;
        const said = this.#record(result, under, key);
        this.#problems = said && said !== STOPPING ? [said] : [];
      });
    }
    const worker = this.#worker;
    try {
      const answer = await worker.ask({ id: request.requestId, call: request.call, args: request.args, repoRoot: folder.real });
      this.#timeouts.delete(d.endpoint);
      if (signal?.aborted) return STOPPING;
      await d.api.postProviderResult(d.hostKey, request.requestId, answer, { signal });
      this.#runs += 1;
      return worker.dropped ? `provider for ${d.endpoint}: dropped ${worker.dropped} unknown or finished answer id(s)` : '';
    } catch (error) {
      if (signal?.aborted) return STOPPING;
      const result = error.result;
      if (!result) throw error;
      await worker.done;
      if (result.timedOut) await d.api.postProviderResult(d.hostKey, request.requestId,
        { ok: false, problem: 'the provider took longer than 90 s' }, { signal });
      return this.#problems.join('; ');
    }
  }

  #record(result, under, key) {
    const d = this.#deps, projectId = d.endpoint;
    if (result.stopped) return STOPPING;
    if (outcomeOf(result) === 'retry') {
      this.#dueAt = d.now() + RUN_EVERY_MS;
      this.delayMs = RUN_EVERY_MS;
    }

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
    return count >= 2 ? `provider for ${projectId}: the provider client ran past its time ${count} times in a row and was stopped` : "";
  }

  /** The dashboard's answer, checked: a malformed one is a failure, never "nothing queued". */
  async #pending(signal) {
    const d = this.#deps;
    const began = d.now();
    const body = await d.api.providerPending(d.hostKey, { signal, waitSeconds: 25 });
    this.delayMs = body?.projects?.length || d.now() - began >= 24_000 ? 0 : RUN_EVERY_MS;
    if (!body || body.hostKey !== d.hostKey || !Array.isArray(body.projects)
      || !body.projects.every((p) => typeof p?.projectId === "string" && Number.isSafeInteger(p?.queued) && p.queued > 0)) {
      throw new Error("the dashboard's answer about queued provider calls was not the shape it should be");
    }
    return body.projects;
  }
}
