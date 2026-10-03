// aify-comms' roster, read as definitions this host could import (P0 C10). PURE.
//
// THE SERVICE'S VOCABULARY STAYS ON THIS SIDE OF THE LINE: `cwd`, `sessionMode`, `runtimeConfig.effort`
// and the runtime names are aify-comms' words, and `lib/agent-import.mjs` sees only definition fields.
//
// WHAT THE ROSTER DOES NOT CARRY IS SAID, NOT FILLED. `env` lives in aify-comms' historical spawn specs,
// not in the agent record, and which spec would be the agent's is ambiguous, so it is always unreported
// and written as {}. Any other field the row omits or leaves null is unreported the same way.

import { HARNESS_RUNTIME } from "../../agent-definition-requests.mjs";

//: The runtime aify-comms records for each harness, inverted from the one table both directions use.
const HARNESS_OF_RUNTIME = Object.freeze(Object.fromEntries(Object.entries(HARNESS_RUNTIME).map(([harness, runtime]) => [runtime, harness])));

//: Each text field of a definition and the roster key aify-comms reports it under.
const TEXT_FIELDS = Object.freeze([["name", "name"], ["role", "role"], ["mode", "sessionMode"],
  ["workspace", "cwd"], ["model", "model"], ["instructions", "instructions"]]);

const said = (value) => typeof value === "string";

/**
 * The definition's effort from aify-comms' `runtimeConfig`, in the order the service's own launch reads
 * them (launch_env.py): a non-empty `effort`, then `thinking`. An explicitly empty one is still a value.
 * @returns {string|undefined} undefined when the service reports neither
 */
function effortOf(config) {
  if (said(config.effort) && config.effort) return config.effort;
  if (said(config.thinking)) return config.thinking;
  return said(config.effort) ? config.effort : undefined;
}

/**
 * One roster row as a definition record: `{id, agent, unreported}`, or `{id, notImportable}`.
 *
 * PROVENANCE PER FIELD. A field the row carries as a string is reported, an empty one included. A field
 * the row omits, or carries as null (no value recorded), is UNREPORTED: written as its neutral value and
 * named, so the import says it rather than presenting "" as what the service said (review of P5, N5).
 */
export function importRecord(id, row) {
  // WITHDRAWN on the service (P0 C6): its definition was removed here, so it is not started. The doctor
  // says so rather than "runs as before", which holds only for an agent that was never defined.
  const withdrawn = row?.definitionState === "withdrawn" ? { withdrawn: true } : {};
  const harness = HARNESS_OF_RUNTIME[row?.runtime];
  if (!harness) return { id, notImportable: `its runtime ${row?.runtime || "(none)"} has no harness`, ...withdrawn };
  const config = row.runtimeConfig && typeof row.runtimeConfig === "object" ? row.runtimeConfig : {};
  const unreported = [];
  const field = (name, value, neutral) => {
    if (value !== undefined) return value;
    unreported.push(name);
    return neutral;
  };
  const text = Object.fromEntries(TEXT_FIELDS.map(([name, key]) => [name, said(row[key]) ? row[key] : undefined]));
  const agent = {
    name: field("name", text.name, ""), role: field("role", text.role, ""), harness,
    mode: field("mode", text.mode, ""), workspace: field("workspace", text.workspace, ""),
    model: field("model", text.model, ""), effort: field("effort", effortOf(config), ""),
    instructions: field("instructions", text.instructions, ""),
    env: field("env", undefined, {}),
    herdrSpace: field("herdrSpace", typeof row.herdrSpace === "boolean" ? row.herdrSpace : undefined, true),
  };
  return { id, unreported, agent, ...withdrawn };
}

/** The roster's agents on `machineId`, as records. Another machine's agents are not this host's to import. */
export function importRecords(roster, machineId) {
  const mine = String(machineId || "").toLowerCase();
  if (!mine) return [];
  return Object.entries(roster?.agents ?? {})
    .filter(([, row]) => String(row?.machineId || "").toLowerCase() === mine)
    .map(([id, row]) => importRecord(id, row));
}
