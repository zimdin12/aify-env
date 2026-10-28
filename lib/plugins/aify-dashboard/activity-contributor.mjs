// What the aify-dashboard plugin adds to a defined worker's env for file activity: the producer's switch, which a
// definition cannot carry because AIFY_* names are reserved (agent-definition-schema.mjs). Offered beside the secrets
// contributor as a second `spawnEnv` offer, with no definition field (lib/plugins/aify-comms/spawn-env.mjs).
//
// `activity.managed` in the plugin's configuration says which starts get it: `true` for every defined worker, or a
// list of agent ids. Anything else, and an `activity` grant that is not enabled, contributes nothing.
//
// A FAULTY CONFIGURATION CONTRIBUTES NOTHING AND REFUSES NO START. File activity observes; a typo in its grant must not
// stop agents starting. The shipper reports the same grant's problems in the plugin's state. A launch that already
// sets the switch is refused by the host (layeredEnv), never silently overridden.

import { activityGrant, activityLaunchEnv } from "./activity-source.mjs";

/** Whether `managed` covers the agent `id`. PURE. */
function managedCovers(managed, id) {
  if (managed === true) return true;
  return Array.isArray(managed) && typeof id === "string" && managed.includes(id);
}

/**
 * @param {object} deps
 * @param {() => {config: object|null}} deps.config  the plugin's configuration reader, read at each start
 */
export function activityContributor({ service = "aify-dashboard", config }) {
  return {
    service,
    async contribute({ definition }) {
      let grant;
      try { grant = activityGrant(config()?.config); } catch { return { env: {} }; }
      if (!grant || !managedCovers(grant.managed, definition?.id)) return { env: {} };
      return { env: activityLaunchEnv(grant) };
    },
  };
}
