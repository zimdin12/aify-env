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
import { serviceIdentity } from "../services.mjs";

/**
 * Service name -> what its plugin is: `create` builds it from a registry entry, and `advertisementPath`, when present,
 * is where that service takes this host's description -- the ADVERTISEMENT capability.
 *
 * A PLUGIN THAT LEAVES `advertisementPath` OUT IS SENT NO HEARTBEAT, which is aify-dashboard's case: it is not an
 * environment tracker. The host's advertiser asks `advertisementPathFor` and never builds a route itself (0.9.7, D13).
 */
//: A MAP, not an object literal: a registry key is whatever a service wrote, and `constructor`, `toString` or
//: `__proto__` indexing a plain object reaches Object.prototype -- an inherited function read as a plugin.
const PLUGINS = new Map([
  ["aify-comms", { create: createCommsPlugin, advertisementPath: COMMS_ADVERTISEMENT_PATH }],
  ["aify-dashboard", { create: createDashboardPlugin }],
]);

/** Names this host has a plugin for. Exported so a doctor can say "registered, but nothing here
 *  speaks to it" rather than staying silent about a service nobody serves. */
export function servicesWithPlugins() {
  return [...PLUGINS.keys()];
}

/**
 * The plugin a registry entry is served by, or null: the ONE lookup both plugin selection and the route below make,
 * through `serviceIdentity`, so the two cannot disagree about which service an entry is.
 */
function pluginFor(service) {
  const { name, admitted } = serviceIdentity(service);
  return admitted ? PLUGINS.get(name) ?? null : null;
}

/**
 * The path a registered service's plugin says it takes this host's description on, or "" when it has no plugin or its
 * plugin offers none. AN ENTRY IN, A PATH OUT, the entry read as plugin selection reads it: the caller joins the path
 * to the service's own endpoint.
 */
export function advertisementPathFor(service) {
  return String(pluginFor(service)?.advertisementPath ?? "");
}

/**
 * What a plugin's factory is given for one registry entry. `service` is the entry itself, so the plugin's key
 * is resolved from the entry it was built for; `hostProof` is this host's proof for THAT service only
 * (lib/host-secret.mjs), read when asked.
 */
export function factoryArguments(service, shared = {}) {
  const { name, endpoint } = serviceIdentity(service);
  const proofFor = shared.hostProofFor ?? hostProofFor;
  return { ...shared, endpoint, service, hostProof: () => proofFor(name) };
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
    const factory = pluginFor(service)?.create ?? null;
    if (!factory) {
      const { name } = serviceIdentity(service);
      if (name) unserved.push(name);
      continue;
    }
    plugins.push(factory(factoryArguments(service, shared)));
  }
  return { plugins, unserved };
}
