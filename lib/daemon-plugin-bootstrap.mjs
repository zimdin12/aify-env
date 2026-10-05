// The daemon's service-plugin host, startup and registry-following closure.
// Called only after listening and orphan reaping. This module never starts a daemon.
import { PluginHost, PluginProcesses } from "./service-plugins.mjs";
import { bootstrapReport, followRegistry, followReport, startServicePlugins } from "./plugin-bootstrap.mjs";

/**
 * Assemble the existing plugin ports and return the advertiser's registry follower.
 * makeShared and readServices are called in the same order as the former inline setup.
 * Credentials and shared getters remain callbacks, so registry edits and key rotation
 * are observed by the asking plugin without a restart.
 */
export async function startDaemonPlugins({ registry, runner, paneOpener, credential, log,
  makeShared, readServices, build, report }) {
  const host = new PluginHost({
    // A dedicated instance's worker gets a Herdr space; an ordinary daemon has no opener.
    processes: new PluginProcesses(runner, { onStarted: paneOpener, prepare: paneOpener?.prepare }),
    // A plugin derives its service-specific environment id from the advertisement.
    environmentId: "",
    credential,
    log,
  });
  const shared = makeShared();
  const outcome = await startServicePlugins({ registry, host, services: readServices(), build, shared });
  for (const line of bootstrapReport(outcome)) report(line);
  let following = null;
  return (services) => { following ??= followRegistry({ registry, host, services, build, shared })
    .then((result) => { for (const line of followReport(result)) log(line); }, (error) => log(`registry follow failed: ${error?.message || error}`))
    .finally(() => { following = null; }); };
}
