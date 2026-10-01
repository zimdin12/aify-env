// aify-comms' roster, read as definitions this host could import (P0 C10). PURE.
//
// THE SERVICE'S VOCABULARY STAYS ON THIS SIDE OF THE LINE: `cwd`, `sessionMode`, `runtimeConfig.effort`
// and the runtime names are aify-comms' words, and `lib/agent-import.mjs` sees only definition fields.
//
// WHAT THE ROSTER DOES NOT CARRY IS SAID, NOT FILLED. `env` lives in aify-comms' historical spawn specs,
// not in the agent record, and which spec would be the agent's is ambiguous, so it is always unreported
// and written as {}. A field an older service leaves out is unreported the same way.

import { HARNESS_RUNTIME } from "../../agent-definition-requests.mjs";

//: The runtime aify-comms records for each harness, inverted from the one table both directions use.
const HARNESS_OF_RUNTIME = Object.freeze(Object.fromEntries(Object.entries(HARNESS_RUNTIME).map(([harness, runtime]) => [runtime, harness])));

const text = (value) => (typeof value === "string" ? value : "");

/** One roster row as a definition record: `{id, agent, unreported}`, or `{id, notImportable}`. */
export function importRecord(id, row) {
  const harness = HARNESS_OF_RUNTIME[row?.runtime];
  if (!harness) return { id, notImportable: `its runtime ${row?.runtime || "(none)"} has no harness` };
  const config = row.runtimeConfig && typeof row.runtimeConfig === "object" ? row.runtimeConfig : {};
  const unreported = ["env"];
  if (typeof row.herdrSpace !== "boolean") unreported.push("herdrSpace");
  return {
    id,
    unreported,
    agent: {
      name: text(row.name), role: text(row.role), harness, mode: text(row.sessionMode), workspace: text(row.cwd),
      // The order the service's own launch reads them in (launch_env.py): effort, then thinking.
      model: text(row.model), effort: text(config.effort) || text(config.thinking), instructions: text(row.instructions),
      env: {}, herdrSpace: row.herdrSpace !== false,
    },
  };
}

/** The roster's agents on `machineId`, as records. Another machine's agents are not this host's to import. */
export function importRecords(roster, machineId) {
  const mine = String(machineId || "").toLowerCase();
  if (!mine) return [];
  return Object.entries(roster?.agents ?? {})
    .filter(([, row]) => String(row?.machineId || "").toLowerCase() === mine)
    .map(([id, row]) => importRecord(id, row));
}
