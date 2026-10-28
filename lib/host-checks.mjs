// The host checks `aify-env doctor` answers beyond the environment's own rows (plan D11, 0.9.7: "each
// doctor checks its own tier"). They used to be in `aify-comms doctor`, which runs on the service's
// side of the line and was asking about this host's processes, consoles and credentials.
//
//   claude-login     the core's own: a credential file on this host, no service involved
//   gateway-orphans  the core's own (0.9.10): hermes gateways no agent lifetime records in its book
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

import { homedir } from "node:os";
import { join } from "node:path";
import { installedHarnesses } from "./advertise.mjs";
import { claudeAgentIds, claudeLoginCheck } from "./claude-login-check.mjs";
import { gatewayOrphansCheck } from "./gateway-orphans-check.mjs";
import { HermesGatewayBook } from "./hermes-gateway-book.mjs";
import { aifyLauncherFilesOnPath } from "./launcher-scan.mjs";
import { failed, STATE } from "./health.mjs";
import { readPluginConfig } from "./plugin-config.mjs";
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
 * @param {(input: {claudeAgents: string[]|null, claudeLauncher: boolean}) => object} [deps.claudeLogin]  the claude-login row
 * @param {() => Array<{client: string}>} [deps.harnesses]  the launchers on PATH, as aify-env advertises them (read, never run)
 * @param {object|null} [deps.definitions]  this host's agent definitions as `DefinitionStore.list()` answers, null unread
 * @param {() => object[]} [deps.gatewayRecords]  the gateway book's records
 * @param {(name: string) => Function|null} [deps.doctorChecksFor]  the registry's lookup
 * @returns {Promise<object[]>} rows, plugins first in registry order, then claude-login and gateway-orphans
 */
export async function collectHostChecks({
  services = [],
  endpoint,
  knock,
  machineId,
  listProcesses,
  credentialFor,
  claudeLogin = claudeLoginCheck,
  gatewayRecords = () => new HermesGatewayBook({ aifyHome: join(homedir(), ".aify") }).records(),
  doctorChecksFor = registryDoctorChecks,
  //: The folders the running aify-env runs work in (its /health `cwdRoots`), null when none answered.
  roots = null,
  readConfig = readPluginConfig,
  definitions = null,
  harnesses = () => installedHarnesses(aifyLauncherFilesOnPath()),
}) {
  const rows = [];
  for (const service of services) {
    const contribute = doctorChecksFor(service?.name);
    if (typeof contribute !== "function") continue;
    rows.push(...await contributedRows(service, () => contribute({
      service,
      credential: () => credentialFor(service),
      envEndpoint: endpoint,
      fetchJson: async (url) => jsonFromKnock(await knock(url)),
      machineId,
      listProcesses,
      roots,
      config: () => readConfig({ name: service?.name }),
    })));
  }
  rows.push(claudeLogin({
    claudeAgents: claudeAgentIds(definitions),
    claudeLauncher: harnesses().some((harness) => harness.client === "claude"),
  }));
  rows.push(gatewayOrphansCheck({ listProcesses, records: gatewayRecords }));
  return rows;
}

const STATES = new Set(Object.values(STATE));

/**
 * One plugin's rows, or ONE FAILED ROW naming the service when the plugin threw or answered something
 * that is not a list of rows. A plugin's fault must cost its own rows and no one else's: before this,
 * a contributor that threw, or answered a non-iterable, rejected the doctor's top-level await and the
 * whole report was lost before either rendering ran.
 */
export async function contributedRows(service, contribute) {
  const name = String(service?.name || "").trim() || "(unnamed service)";
  const id = `${name} host checks`;
  const fix = `this is a fault in aify-env's plugin for ${name}, not on this host: report it with this line`;
  let answer;
  try {
    answer = await contribute();
  } catch (error) {
    return [failed(id, `the ${name} plugin's host checks threw: ${error?.message || error}`, fix)];
  }
  const isRow = (row) => row && typeof row === "object" && typeof row.id === "string" && STATES.has(row.state);
  if (!Array.isArray(answer) || !answer.every(isRow)) {
    return [failed(id, `the ${name} plugin's host checks answered something that is not a list of rows`, fix)];
  }
  return answer;
}
