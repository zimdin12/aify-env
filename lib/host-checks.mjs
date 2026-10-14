// The host checks `aify-env doctor` answers beyond the environment's own rows (plan D11, 0.9.7: "each
// doctor checks its own tier"). They used to be in `aify-comms doctor`, which runs on the service's
// side of the line and was asking about this host's processes, consoles and credentials.
//
//   claude-login     the core's own: a credential file on this host, no service involved
//   everything else  from each registered service's plugin, asked for by name through the registry
//
// THE CORE NAMES NO SERVICE. It walks the registered services and asks `doctorChecksFor(name)`; a
// service whose plugin answers nothing adds nothing. So a host with no aify-comms registered gets no
// aify-comms rows -- the question does not apply -- and a registered one whose service is down gets its
// rows UNANSWERED, because each check already says so when its reads come back empty.
//
// ONLY THE DOCTOR PASSES THIS. The view (lib/dashboard.mjs) refreshes the environment rows on a timer,
// and a console fan-out plus a whole-host process listing on every tick would cost more than the
// screen is worth.

import { claudeLoginCheck } from "./claude-login-check.mjs";
import { doctorChecksFor as registryDoctorChecks } from "./plugins/index.mjs";

/**
 * A JSON body for a 2xx answer, or null. `knock` reports ok for any response it could parse, a 404
 * included, and a row that read a 404 body as a listing would be judging an error page.
 */
export function jsonFromKnock(answer) {
  return answer?.ok && answer.status >= 200 && answer.status < 300 ? answer.body ?? null : null;
}

/**
 * @param {object} deps
 * @param {Array<{name: string, endpoint: string}>} deps.services  the registry's services, already read
 * @param {string} deps.endpoint            the aify-env this doctor found serving the host
 * @param {(url: string) => Promise<object>} deps.knock  one HTTP question, already budgeted
 * @param {string} deps.machineId           this host's machine id (lib/advertise.mjs `machineIdFor`)
 * @param {() => object[]} deps.listProcesses  every process on this host; throws when unreadable
 * @param {(service: object) => Promise<string>} deps.credentialFor  the key for one registry entry
 * @param {() => object} [deps.claudeLogin]  the claude-login row
 * @param {(name: string) => Function|null} [deps.doctorChecksFor]  the registry's lookup
 * @returns {Promise<object[]>} rows, plugins first in registry order, then claude-login
 */
export async function collectHostChecks({
  services = [],
  endpoint,
  knock,
  machineId,
  listProcesses,
  credentialFor,
  claudeLogin = claudeLoginCheck,
  doctorChecksFor = registryDoctorChecks,
}) {
  const rows = [];
  for (const service of services) {
    const contribute = doctorChecksFor(service?.name);
    if (!contribute) continue;
    rows.push(...await contribute({
      service,
      credential: () => credentialFor(service),
      envEndpoint: endpoint,
      fetchJson: async (url) => jsonFromKnock(await knock(url)),
      machineId,
      listProcesses,
    }));
  }
  rows.push(claudeLogin());
  return rows;
}
