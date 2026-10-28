// The doctor rows aify-comms' plugin answers: the host checks that moved out of `aify-comms doctor` in
// 0.9.7 (plan D11, "each doctor checks its own tier") and still need aify-comms' records to judge.
//
//   env-processes    what aify-env runs, against aify-comms' live terminals
//   context-window   each running managed console's own `used/limit` footer
//   managed-orphans  delivery loops on this host bound to no live bridge
//   auto-confirm, claude-trust-roots  the dialogs this plugin answers, and whether claude needs them answered
//
// The core doctor (lib/host-checks.mjs) asks the plugin registry for this function by service name and
// never learns what is inside. Each check keeps the id, the detection logic and the codes it had in
// aify-comms; `fromVerdict` turns each verdict into this doctor's row and keeps the code.
//
// READ-ONLY. Every request is a GET through a named `CommsApi` read, carrying the key the registry entry
// resolves to and no host proof: these routes need none, and a doctor has no host claim to make.

import { fromVerdict } from "../../health.mjs";
import { CommsApi, mintBridgeIdentity } from "./api.mjs";
import { checkContextWindow } from "./context-window-check.mjs";
import { checkEnvProcesses } from "./env-processes-check.mjs";
import { checkManagedOrphans } from "./managed-orphans-check.mjs";
import { checkAutoConfirm } from "./auto-confirm-checks.mjs";

/** The reads the checks make, by name: one `CommsApi` method each. */
const READS = ["agents", "liveTerminals", "environments", "bridges", "agentConsole"];

/**
 * Each read, answering null for anything but a JSON body: unreachable, refused, not found. The checks
 * treat null as "the service did not answer", the contract they were written against in aify-comms.
 */
export function serviceReads(api) {
  return Object.fromEntries(READS.map((name) => [name, async (...args) => {
    try {
      return await api[name](...args);
    } catch {
      return null;
    }
  }]));
}

/**
 * @param {object} deps
 * @param {{endpoint: string}} deps.service        this service's registry entry
 * @param {() => Promise<string>} deps.credential  the key for that entry, resolved when asked
 * @param {string} deps.envEndpoint                the aify-env this doctor found serving the host
 * @param {(url: string) => Promise<object|null>} deps.fetchJson  one JSON GET outside the service
 * @param {string} deps.machineId                  this host's machine id
 * @param {() => object[]} deps.listProcesses      every process on this host; throws when unreadable
 * @param {string[]|null} [deps.roots]            the folders the running aify-env runs work in, null when unknown
 * @param {() => object} [deps.config]             this plugin's section of ~/.aify/config.json (lib/plugin-config.mjs)
 * @param {() => string} [deps.readClaudeConfig]   ~/.claude.json's text; injected by tests
 * @param {object} [deps.reads]                    injected by tests in place of `serviceReads(api)`
 * @returns {Promise<object[]>} the rows, in reading order
 */
export async function commsDoctorChecks({
  service, credential, envEndpoint, fetchJson, machineId, listProcesses, reads = null, fetchImpl = globalThis.fetch,
  roots = null, config = null, readClaudeConfig = undefined, windows = process.platform === "win32",
}) {
  const read = reads ?? serviceReads(new CommsApi({
    endpoint: service.endpoint, credential, identity: mintBridgeIdentity(), fetchImpl,
  }));
  const rows = [];
  const add = (id, ok, code, detail, fix = "") => { rows.push(fromVerdict(id, { ok, code, detail, fix })); };
  const skip = (id, detail) => { rows.push(fromVerdict(id, { ok: true, code: "skipped", detail })); };

  await checkEnvProcesses({ reads: read, add, skip, fetchJson, machineId, endpoint: envEndpoint });
  await checkContextWindow({ reads: read, add, skip });
  await checkManagedOrphans({ reads: read, add, listProcesses });
  checkAutoConfirm({ add, roots, config, readClaudeConfig, windows });
  return rows;
}
