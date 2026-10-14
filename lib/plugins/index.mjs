// Which plugin serves which registered service.
//
// THE HOST MUST NOT KNOW. `bin/aify-env.mjs` asks this for the plugins a set of registered services
// needs and starts whatever comes back; it never names a service. That is what keeps the daemon
// general -- adding a second `aify-` service is an entry here plus a directory beside this file, and
// nothing in the host changes.
//
// A NAME IS NOT COUPLING, and the boundary gate deliberately does not treat it as such: what makes a
// module a service's own is naming its PROTOCOL -- an endpoint, a header, a request shape. This file
// maps names to factories and to what each plugin offers, and spells no protocol itself: a route it hands
// the host is the plugin's own constant.

import { ADVERTISEMENT_PATH as COMMS_ADVERTISEMENT_PATH } from "./aify-comms/api.mjs";
import { createCommsPlugin } from "./aify-comms/index.mjs";
import { createDashboardPlugin } from "./aify-dashboard/index.mjs";
import { hostProofFor } from "../host-secret.mjs";

/**
 * Service name -> what its plugin is: `create` builds it from a registry entry, and `advertisementPath`, when present,
 * is where that service takes this host's description -- the ADVERTISEMENT capability.
 *
 * A PLUGIN THAT LEAVES `advertisementPath` OUT IS SENT NO HEARTBEAT, which is aify-dashboard's case: it is not an
 * environment tracker. The host's advertiser asks `advertisementPathFor` and never builds a route itself (0.9.7, D13).
 */
const PLUGINS = {
  "aify-comms": { create: createCommsPlugin, advertisementPath: COMMS_ADVERTISEMENT_PATH },
  "aify-dashboard": { create: createDashboardPlugin },
};

/** Names this host has a plugin for. Exported so a doctor can say "registered, but nothing here
 *  speaks to it" rather than staying silent about a service nobody serves. */
export function servicesWithPlugins() {
  return Object.keys(PLUGINS);
}

/**
 * The path a registered service's plugin says it takes this host's description on, or "" when it has no plugin or its
 * plugin offers none. A NAME IN, A PATH OUT: the caller joins it to the service's own endpoint.
 */
export function advertisementPathFor(name) {
  const plugin = Object.hasOwn(PLUGINS, String(name ?? "")) ? PLUGINS[name] : null;
  return String(plugin?.advertisementPath ?? "");
}

/**
 * What a plugin's factory is given for one registry entry. `service` is the entry itself, so the plugin's key
 * is resolved from the entry it was built for; `hostProof` is this host's proof for THAT service only
 * (lib/host-secret.mjs), read when asked.
 */
export function factoryArguments(service, shared = {}) {
  const name = String(service?.name || "").trim();
  const proofFor = shared.hostProofFor ?? hostProofFor;
  return { ...shared, endpoint: String(service?.endpoint || "").trim(), service, hostProof: () => proofFor(name) };
}

/**
 * Build a plugin for every registered service this host can serve.
 *
 * A SERVICE WITH NO PLUGIN IS NOT AN ERROR. A host may legitimately advertise to a service it cannot
 * host work for -- describing a machine and running processes for it are different offers, and the
 * whole point of the split is that the first does not imply the second.
 *
 * @param {Array<{name: string, endpoint: string}>} services  registry entries
 * @param {object} shared  what every plugin needs from the host that is not the host itself
 * @returns {{plugins: object[], unserved: string[]}}
 */
export function pluginsForServices(services = [], shared = {}) {
  const plugins = [];
  const unserved = [];
  for (const service of services) {
    const name = String(service?.name || "").trim();
    const endpoint = String(service?.endpoint || "").trim();
    const factory = Object.hasOwn(PLUGINS, name) ? PLUGINS[name].create : null;
    if (!factory || !endpoint) {
      if (name) unserved.push(name);
      continue;
    }
    plugins.push(factory(factoryArguments(service, shared)));
  }
  return { plugins, unserved };
}
