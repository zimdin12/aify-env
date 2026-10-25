// The aify-dashboard plugin: this host's git facts, for the folders the dashboard lists and the
// operator granted.
//
// ONCE PER HOST. Two daemons reporting one folder would each undo the other's idea of where its HEAD is
// (the dashboard refuses the second inside its one-minute window and raises `two_reporters`). A herdr's
// dedicated instance starts service plugins too, so before each tick it asks `servedElsewhere`, which is
// "an ordinary aify-env answers at the default address", the same one aify-env's own commands choose
// first. While one does, this plugin skips the tick and says why in its state, which `/health` shows.
// It used to decline on every dedicated instance, and a host whose only aify-env is herdr-aify's (the
// operator's, 2026-10-13) then had no git facts at all.
//
// IT CLAIMS NO WORK. Its state has no `claimer`, so the doctor's claiming row does not count it. The code provider's
// client it starts claims calls from the dashboard's own queue, which is not comms work (`ProviderRunner`).

import { randomUUID } from "node:crypto";

import { DashboardApi } from "./dashboard-api.mjs";
import { activityContributor } from "./activity-contributor.mjs";
import { ActivityShipper } from "./activity-shipper.mjs";
import { GitReader } from "./git-reader.mjs";
import { HeadWatcher, TICK_MS } from "./head-watcher.mjs";
import { hostKeyOf } from "./locations.mjs";
import { CleanupWarnings, ProviderRunner, RUN_EVERY_MS } from "./provider-runner.mjs";
import { secretsContributor } from "./secrets-contributor.mjs";
import { SweepRunner } from "./sweep-runner.mjs";

export const PLUGIN_NAME = "aify-dashboard";

/**
 * ONE PER PROCESS: the rows saying a provider client's tree was not confirmed ended. Each start builds a new runner,
 * and a registry change a new plugin, and neither says the old tree is gone, so the rows outlive both until aify-env
 * restarts (review of a84ed99). A restart forgets them; that is not evidence the tree ended.
 */
const CLEANUP_WARNINGS = new CleanupWarnings();

/** Why a dedicated instance is not watching. */
export const DEDICATED_DECLINE = "an ordinary aify-env serves this host and watches its folders; this herdr instance defers to it";

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
  const { machineId = "", servedElsewhere = async () => false, watchRoots, endpoint = "", service = null, config, agents } = shared;
  const { git = null, fetch = globalThis.fetch, now = Date.now, tickMs = TICK_MS, runEveryMs = RUN_EVERY_MS, runChild } = overrides;
  let declined = "";

  let watcher = null;
  let runner = null;
  let sweeper = null;
  let shipper = null;
  let timer = null;
  let running = null;
  let runTimer = null;
  let runRunning = null;
  let stopped = true;
  let cancel = null;
  let api = null;

  // CANCEL, THEN WAIT. The tick in flight is told to stop (its git process killed, its request aborted, no
  // further folder looked at, a provider client killed with its tree), so the wait is for that to unwind, not for
  // the work to finish. The host stops plugins one after another inside a shared budget, and this one's work is
  // optional.
  async function stop() {
    stopped = true;
    // The contributor's client is dropped and its signal aborted before anything is awaited, so no ask that begins
    // while the watcher unwinds gets a client, and one in flight sees the abort (secrets-contributor.mjs).
    api = null;
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
      // ⛔ A decline still says the kills not confirmed. They outlive a runner's stop and a plugin's rebuild until
      // aify-env restarts, and yielding to another aify-env is neither: a run then a decline dropped the row, and the
      // doctor's plugin-problems row passed while the tree was not confirmed ended (comms-senior-dev, R1 on 155b6d5).
      if (declined) return { phase: "declined", declined, problems: CLEANUP_WARNINGS.rows() };
      const watching = watcher ? watcher.state() : { problems: [] };
      const provider = runner ? runner.state() : { runs: 0, stopped: [], problems: CLEANUP_WARNINGS.rows() };
      const sweeps = sweeper ? sweeper.state() : { runs: 0, stopped: [], problems: [] };
      const activity = shipper?.state();
      return { phase: stopped ? "stopped" : "running", ...watching,
        ...(activity ? { activity: { passes: activity.passes, coverage: activity.coverage } } : {}),
        provider: { runs: provider.runs, stopped: provider.stopped, sweeps: sweeps.runs, sweepsStopped: sweeps.stopped },
        // A Set: both runners report the one store of kills not confirmed, and each row is said once.
        problems: [...new Set([...watching.problems, ...provider.problems, ...sweeps.problems, ...(activity?.problems ?? [])])] };
    },

    // A worker's secrets, fetched at its start, and its file-activity switch when `activity.managed` covers it. Offered on
    // a dedicated instance too, which starts workers.
    capabilities: {
      spawnEnv: [
        secretsContributor({ service: PLUGIN_NAME, api: () => api, stopped: () => cancel?.signal ?? null }),
        activityContributor({ service: PLUGIN_NAME, config: typeof config === "function" ? config : noConfig }),
      ],
    },

    async start(host) {
      cancel = new AbortController();
      // The plugin's one client, kept beside the plugin so its spawnEnv contributor fetches a worker's secrets with it
      // (secrets-contributor.mjs). No start-time decline here: on 0.9 a yield is decided per tick, and a dedicated
      // instance that yields its watcher still starts workers, whose secrets are fetched all the same.
      api = new DashboardApi({ endpoint, fetch, credential: () => host.credential(service),
        secretsCredential: () => host.credential(service, "secretsCredentialRef") });
      shipper = new ActivityShipper({ api, endpoint: String(endpoint || ""), config: typeof config === "function" ? config : noConfig, agents });
      stopped = false;
      const { signal } = cancel;
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
        cleanupWarnings: CLEANUP_WARNINGS,
        ...(runChild ? { run: runChild } : {}),
      });
      // The same folders, grant, checkout and key as the queue client, and none of its reporter (sweep-runner.mjs).
      sweeper = new SweepRunner({
        api,
        credential: () => host.credential(service),
        folders: () => watcher.watched(),
        watchRoots: grant,
        config: typeof config === "function" ? config : noConfig,
        endpoint: String(endpoint || ""),
        hostKey: hostKeyOf(machineId),
        cleanupWarnings: CLEANUP_WARNINGS,
        ...(runChild ? { run: runChild } : {}),
      });
      // Not awaited: the first tick fetches over the network, and the host's start must not wait on it.
      // Asked before every tick, so this instance yields within a tick of an ordinary one starting and resumes
      // within a tick of it stopping. ponytail: one loopback /health per tick; a cache when that ever shows up.
      const tick = async () => {
        const yielded = declined !== "";
        declined = (await servedElsewhere({ signal }).catch(() => false)) === true ? DEDICATED_DECLINE : "";
        // ⛔ Back from yielding, every folder is reported again: the other aify-env may have moved the dashboard while
        // this one kept its last report (comms-senior-dev, R2 on 155b6d5).
        if (yielded && !declined) watcher.forgetReported();
        if (!declined && !signal.aborted) await watcher.tick({ signal });
        if (!declined && !signal.aborted) await shipper.pass({ signal });
      };
      const loop = () => {
        running = tick().finally(() => {
          running = null;
          if (stopped) return;
          timer = setTimeout(loop, tickMs);
          timer.unref?.();
        });
      };
      loop();
      // The first pass waits a whole interval, so the watch list has had time to arrive before any folder is served.
      const runLoop = () => {
        // The same yield as the head watcher's: while an ordinary aify-env serves this host, its plugin runs the
        // provider client, and two clients on one host would each claim calls the other is answering. The sweep follows
        // the queue client in the same pass, so the two never run at once.
        runRunning = (declined ? Promise.resolve() : runner.pass({ signal }).then(() => (signal.aborted ? undefined : sweeper.pass({ signal })))).finally(() => {
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
