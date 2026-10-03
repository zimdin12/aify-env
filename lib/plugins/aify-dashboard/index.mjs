// The aify-dashboard plugin: this host's git facts, for the folders the dashboard lists and the
// operator granted.
//
// ONCE PER HOST. A herdr's dedicated instance starts service plugins too, and two daemons reporting one
// folder would each undo the other's idea of where its HEAD is. So on a dedicated instance this plugin
// is built, starts nothing, and says why in its state, which is what `/health` shows. Returning no
// plugin at all would need the host to know which services may decline, and the host names none.
//
// IT CLAIMS NO WORK. Its state has no `claimer`, so the doctor's claiming row does not count it. The code provider's
// client it starts claims calls from the dashboard's own queue, which is not comms work (`ProviderRunner`).

import { randomUUID } from "node:crypto";

import { DashboardApi } from "./dashboard-api.mjs";
import { GitReader } from "./git-reader.mjs";
import { HeadWatcher, TICK_MS } from "./head-watcher.mjs";
import { hostKeyOf } from "./locations.mjs";
import { ProviderRunner, RUN_EVERY_MS } from "./provider-runner.mjs";

export const PLUGIN_NAME = "aify-dashboard";

/** Why a dedicated instance starts nothing. */
export const DEDICATED_DECLINE = "this is a herdr's dedicated aify-env instance; the host's serving instance watches its folders";

/** Fails closed: an aify-env that does not offer `watchRoots` has granted no folder. */
async function noWatchRoots() {
  throw new Error("this aify-env offers no watchRoots setting");
}

/** Fails closed: an aify-env that hands this plugin no config reader has granted no provider checkout. */
function noConfig() {
  return { config: null, problem: "this aify-env hands its plugins no configuration" };
}

/**
 * @param {object} shared  what the host gives every plugin, plus this entry's `endpoint` and `service`
 * @param {object} [overrides]  test seams: `git`, `fetch`, `now`, `tickMs`, `runEveryMs`, `runChild`
 */
export function createDashboardPlugin(shared = {}, overrides = {}) {
  const { machineId = "", dedicated = false, watchRoots, endpoint = "", service = null, config } = shared;
  const { git = null, fetch = globalThis.fetch, now = Date.now, tickMs = TICK_MS, runEveryMs = RUN_EVERY_MS, runChild } = overrides;
  const declined = dedicated === true ? DEDICATED_DECLINE : "";

  let watcher = null;
  let runner = null;
  let timer = null;
  let running = null;
  let runTimer = null;
  let runRunning = null;
  let stopped = true;
  let cancel = null;

  // CANCEL, THEN WAIT. The tick in flight is told to stop (its git process killed, its request aborted, no
  // further folder looked at, a provider client killed with its tree), so the wait is for that to unwind, not for
  // the work to finish. The host stops plugins one after another inside a shared budget, and this one's work is
  // optional.
  async function stop() {
    stopped = true;
    cancel?.abort();
    clearTimeout(timer);
    clearTimeout(runTimer);
    timer = null;
    runTimer = null;
    await Promise.all([running, runRunning]);
  }

  return {
    name: PLUGIN_NAME,
    endpoint: String(endpoint || ""),

    /** For `/health` and the doctor: what this plugin is doing, and what it could not do. */
    state: () => {
      if (declined) return { phase: "declined", declined, problems: [] };
      const watching = watcher ? watcher.state() : { problems: [] };
      const provider = runner ? runner.state() : { runs: 0, stopped: [], problems: [] };
      return { phase: stopped ? "stopped" : "running", ...watching, provider: { runs: provider.runs, stopped: provider.stopped },
        problems: [...watching.problems, ...provider.problems] };
    },

    async start(host) {
      if (declined) return;
      stopped = false;
      cancel = new AbortController();
      const { signal } = cancel;
      const api = new DashboardApi({ endpoint, credential: () => host.credential(service), fetch });
      // One per process: a restarted daemon is a new reporter, and the dashboard's one-minute window
      // tells two live ones apart by this id.
      const reporter = `aify-env:${machineId}:${randomUUID()}`;
      const grant = typeof watchRoots === "function" ? watchRoots : noWatchRoots;
      watcher = new HeadWatcher({
        api,
        git: git ?? new GitReader(),
        machineId,
        watchRoots: grant,
        reporter,
        now,
      });
      runner = new ProviderRunner({
        api,
        credential: () => host.credential(service),
        folders: () => watcher.watched(),
        watchRoots: grant,
        config: typeof config === "function" ? config : noConfig,
        endpoint: String(endpoint || ""),
        hostKey: hostKeyOf(machineId),
        reporter,
        ...(runChild ? { run: runChild } : {}),
      });
      // Not awaited: the first tick fetches over the network, and the host's start must not wait on it.
      const loop = () => {
        running = watcher.tick({ signal }).finally(() => {
          running = null;
          if (stopped) return;
          timer = setTimeout(loop, tickMs);
          timer.unref?.();
        });
      };
      loop();
      // The first pass waits a whole interval, so the watch list has had time to arrive before any folder is served.
      const runLoop = () => {
        runRunning = runner.pass({ signal }).finally(() => {
          runRunning = null;
          if (stopped) return;
          runTimer = setTimeout(runLoop, runEveryMs);
          runTimer.unref?.();
        });
      };
      runTimer = setTimeout(runLoop, runEveryMs);
      runTimer.unref?.();
    },

    stop,

    /** A registry change that drops the service. Nothing here outlives the plugin, so it always detaches. */
    async detach() {
      await stop();
      return { detached: true, held: 0 };
    },
  };
}
