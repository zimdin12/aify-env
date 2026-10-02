// The aify-dashboard plugin: this host's git facts, for the folders the dashboard lists and the
// operator granted.
//
// ONCE PER HOST. A herdr's dedicated instance starts service plugins too, and two daemons reporting one
// folder would each undo the other's idea of where its HEAD is. So on a dedicated instance this plugin
// is built, starts nothing, and says why in its state, which is what `/health` shows. Returning no
// plugin at all would need the host to know which services may decline, and the host names none.
//
// IT CLAIMS NO WORK. Its state has no `claimer`, so the doctor's claiming row does not count it.

import { randomUUID } from "node:crypto";

import { DashboardApi } from "./dashboard-api.mjs";
import { GitReader } from "./git-reader.mjs";
import { HeadWatcher, TICK_MS } from "./head-watcher.mjs";

export const PLUGIN_NAME = "aify-dashboard";

/** Why a dedicated instance starts nothing. */
export const DEDICATED_DECLINE = "this is a herdr's dedicated aify-env instance; the host's serving instance watches its folders";

/** Fails closed: an aify-env that does not offer `watchRoots` has granted no folder. */
async function noWatchRoots() {
  throw new Error("this aify-env offers no watchRoots setting");
}

/**
 * @param {object} shared  what the host gives every plugin, plus this entry's `endpoint` and `service`
 * @param {object} [overrides]  test seams: `git`, `fetch`, `now`, `tickMs`
 */
export function createDashboardPlugin(shared = {}, overrides = {}) {
  const { machineId = "", dedicated = false, watchRoots, endpoint = "", service = null } = shared;
  const { git = null, fetch = globalThis.fetch, now = Date.now, tickMs = TICK_MS } = overrides;
  const declined = dedicated === true ? DEDICATED_DECLINE : "";

  let watcher = null;
  let timer = null;
  let running = null;
  let stopped = true;
  let cancel = null;

  // CANCEL, THEN WAIT. The tick in flight is told to stop (its git process killed, its request aborted, no
  // further folder looked at), so the wait is for that to unwind, not for the tick to finish its work. The
  // host stops plugins one after another inside a shared budget, and this one's reporting is optional.
  async function stop() {
    stopped = true;
    cancel?.abort();
    clearTimeout(timer);
    timer = null;
    await running;
  }

  return {
    name: PLUGIN_NAME,
    endpoint: String(endpoint || ""),

    /** For `/health` and the doctor: what this plugin is doing, and what it could not do. */
    state: () => {
      if (declined) return { phase: "declined", declined, problems: [] };
      return { phase: stopped ? "stopped" : "running", ...(watcher ? watcher.state() : { problems: [] }) };
    },

    async start(host) {
      if (declined) return;
      stopped = false;
      cancel = new AbortController();
      const { signal } = cancel;
      watcher = new HeadWatcher({
        api: new DashboardApi({ endpoint, credential: () => host.credential(service), fetch }),
        git: git ?? new GitReader(),
        machineId,
        watchRoots: typeof watchRoots === "function" ? watchRoots : noWatchRoots,
        // One per process: a restarted daemon is a new reporter, and the dashboard's one-minute window
        // tells two live ones apart by this id.
        reporter: `aify-env:${machineId}:${randomUUID()}`,
        now,
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
    },

    stop,

    /** A registry change that drops the service. Nothing here outlives the plugin, so it always detaches. */
    async detach() {
      await stop();
      return { detached: true, held: 0 };
    },
  };
}
