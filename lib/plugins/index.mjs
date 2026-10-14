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
import { commsDoctorChecks } from "./aify-comms/doctor-checks.mjs";
import { hostProofFor } from "../host-secret.mjs";
import { serviceIdentity } from "../services.mjs";

// MAPS, NOT OBJECT LITERALS, because both are indexed by a name read out of the registry -- a shared
// file anything on the host can write. A plain object answers `constructor`, `toString` or `__proto__`
// with what it inherits from Object.prototype: a service registered as `constructor` was handed the
// Object function as its doctor contributor, which the doctor called and then failed to spread, losing
// the whole report (review of b7fad9c, P2). A Map holds only what was put in it.

/**
 * Service name -> what its plugin is: `create` builds it from a registry entry, and `advertisementPath`, when present,
 * is where that service takes this host's description -- the ADVERTISEMENT capability.
 *
 * A PLUGIN THAT LEAVES `advertisementPath` OUT IS SENT NO HEARTBEAT, which is aify-dashboard's case: it is not an
 * environment tracker. The host's advertiser asks `advertisementPathFor` and never builds a route itself (0.9.7, D13).
 */
const PLUGINS = new Map([
  ["aify-comms", { create: createCommsPlugin, advertisementPath: COMMS_ADVERTISEMENT_PATH }],
  ["aify-dashboard", { create: createDashboardPlugin }],
]);

/**
 * Service name -> the doctor rows its plugin answers for this host, for `aify-env doctor`
 * (lib/host-checks.mjs). A service without an entry contributes no rows.
 */
const DOCTOR_CHECKS = new Map([
  ["aify-comms", commsDoctorChecks],
]);

/** What a table holds for `name`, when it is a function; null for anything else. Exported for its test. */
export function callableFor(table, name) {
  const entry = table.get(String(name || "").trim());
  return typeof entry === "function" ? entry : null;
}

/** The doctor-row contributor for one registered service, or null when its plugin has none. */
export function doctorChecksFor(name) {
  return callableFor(DOCTOR_CHECKS, name);
}

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
    // `serviceIdentity` admits an entry only with both a name and an endpoint; the factory must also be callable.
    const create = pluginFor(service)?.create;
    const factory = typeof create === "function" ? create : null;
    if (!factory) {
      const { name } = serviceIdentity(service);
      if (name) unserved.push(name);
      continue;
    }
    plugins.push(factory(factoryArguments(service, shared)));
  }
  return { plugins, unserved };
}
