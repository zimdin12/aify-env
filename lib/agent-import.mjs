// What `aify-env agents import` would write, and why not, for every agent the services report (P0 C10).
//
// PURE: the reports come from the services, the defined ids and the definition check from the caller.
// Nothing here reads a store, a service or a clock, so the rules are testable as they are.
//
// AN IMPORT NEVER GUESSES. An id two services describe differently is not written until the operator
// picks one with `--prefer`; registry order is not a choice. An id already defined here is never
// overwritten. A field a service cannot report is said, never presented as a value it reported.

import { definitionProblems, SCHEMA_VERSION } from "./agent-definition-schema.mjs";

/**
 * The check an import makes before it writes: the definition as the store would validate a new one, and
 * a launcher for its harness. The store makes both again on `--write`; this says them on the dry run.
 * @param {Set<string>} installed  the harnesses this host can launch
 */
export const definitionCheck = (installed) => (id, agent) => [
  ...definitionProblems({ version: SCHEMA_VERSION, agent: { ...agent, id } }, id),
  ...(installed.has(agent.harness) ? [] : [`the ${agent.harness} launcher is not installed on this host`]),
];

/** What a row will do. */
export const DECISION = Object.freeze({
  IMPORT: "import",
  DEFINED: "already defined here",
  CONFLICT: "conflict",
  NOT_IMPORTABLE: "not importable",
  INVALID: "invalid",
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `--prefer <service>` or `--prefer <service>:<id>`. The service name is everything before the LAST
 * colon only when what follows is a non-empty id, so a bare service name never loses a character.
 * @returns {{service: string, id: string}|null} null for an empty argument
 */
export function parsePrefer(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const at = value.lastIndexOf(":");
  return at > 0 && at < value.length - 1
    ? { service: value.slice(0, at), id: value.slice(at + 1) }
    : { service: value, id: "" };
}

/** Which service the operator chose for `id` among `services`: one naming the id beats one naming none. */
function preferred(id, services, prefer) {
  const named = prefer.find((p) => p.id === id && services.includes(p.service));
  return (named ?? prefer.find((p) => !p.id && services.includes(p.service)))?.service ?? "";
}

/** Each field whose value differs between the records, with every service's value. */
function conflictsOf(records) {
  const fields = [...new Set(records.flatMap((r) => Object.keys(r.agent)))].sort();
  return fields
    .filter((field) => records.some((r) => !same(r.agent[field], records[0].agent[field])))
    .map((field) => ({ field, values: records.map((r) => ({ service: r.service, value: r.agent[field] })) }));
}

/**
 * @param {object} input
 * @param {Array<{service: string, agents?: Array<{id: string, agent?: object, unreported?: string[],
 *   notImportable?: string}>}>} input.reports   what each service said about this machine's agents
 * @param {Iterable<string>} input.defined        ids this host already defines (compared without case,
 *                                                as the store compares them)
 * @param {Array<{service: string, id: string}>} [input.prefer]  the operator's choices
 * @param {(id: string, agent: object) => string[]} input.check  problems with a definition, [] if none
 * @returns {Array<object>} one row per id, sorted by id
 */
export function importPlan({ reports, defined, prefer = [], check }) {
  const definedHere = new Set([...defined].map((id) => String(id).toLowerCase()));
  const byId = new Map();
  for (const report of reports) {
    for (const record of report.agents ?? []) {
      byId.set(record.id, [...(byId.get(record.id) ?? []), { ...record, service: report.service }]);
    }
  }
  return [...byId.keys()].sort().map((id) => {
    const records = byId.get(id).sort((a, b) => a.service.localeCompare(b.service));
    const row = { id, sources: records.map((r) => r.service), decision: "", from: "", agent: null, unreported: [], conflicts: [], problems: [], notes: [] };
    if (definedHere.has(id.toLowerCase())) return { ...row, decision: DECISION.DEFINED };
    const importable = records.filter((r) => !r.notImportable);
    // A SERVICE THAT COULD NOT DESCRIBE IT is a note on the row, never a vote: the others decide.
    const notes = records.filter((r) => r.notImportable).map((r) => `${r.service}: ${r.notImportable}`);
    if (!importable.length) return { ...row, decision: DECISION.NOT_IMPORTABLE, notes };
    const conflicts = conflictsOf(importable);
    const from = conflicts.length ? preferred(id, importable.map((r) => r.service), prefer) : importable[0].service;
    if (!from) return { ...row, decision: DECISION.CONFLICT, conflicts, notes };
    const chosen = importable.find((r) => r.service === from);
    const problems = check(id, chosen.agent);
    return {
      ...row, from, agent: chosen.agent, unreported: [...(chosen.unreported ?? [])], conflicts, problems, notes,
      decision: problems.length ? DECISION.INVALID : DECISION.IMPORT,
    };
  });
}

const shown = (value) => (typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value ?? null));

/** The fields of a definition as one line, instructions by length: they can be pages long. */
function fieldsLine(agent) {
  return Object.entries(agent)
    .map(([field, value]) => (field === "instructions" ? `instructions: ${[...String(value)].length} characters` : `${field}: ${shown(value)}`))
    .join(" | ");
}

/** What the operator reads for each row: its decision, its values, and what no service could say. */
export function planLines(rows) {
  const lines = [];
  for (const row of rows) {
    const notes = row.notes.map((note) => `      note: ${note}`);
    if (row.decision === DECISION.DEFINED) {
      lines.push(`${row.id}  already defined here; not overwritten (reported by ${row.sources.join(", ")})`);
    } else if (row.decision === DECISION.NOT_IMPORTABLE) {
      lines.push(`${row.id}  not importable`, ...notes);
    } else if (row.decision === DECISION.CONFLICT) {
      lines.push(`${row.id}  conflict between ${row.sources.join(" and ")}; not written until you choose with`
        + ` --prefer <service> or --prefer <service>:${row.id}`);
      for (const conflict of row.conflicts) {
        lines.push(`      ${conflict.field}: ${conflict.values.map((v) => `${v.service} ${shown(v.value)}`).join(", ")}`);
      }
      lines.push(...notes);
    } else {
      const label = row.decision === DECISION.INVALID ? "invalid, so not written" : "import";
      lines.push(`${row.id}  ${label}, from ${row.from}${row.conflicts.length ? " (your --prefer)" : ""}`);
      lines.push(`      ${fieldsLine(row.agent)}`);
      if (row.unreported.length) {
        lines.push(`      not reported by ${row.from}: ${row.unreported.map((field) => `${field} (written as ${shown(row.agent[field])})`).join(", ")}`);
      }
      for (const problem of row.problems) lines.push(`      problem: ${problem}`);
      lines.push(...notes);
    }
  }
  return lines;
}
