// A snapshot's entries and their canonical digest (P0 C3). PURE.
//
// The digest covers everything the service acts on -- validity, problems, counters, the definition's
// own digest, availability -- so a change in any of them advances the collection revision exactly like
// a change in a file. It does not cover the `definition` body itself, which `definitionDigest` stands
// for. The same state enumerated in another order gives the same digest.

import { canonicalJson, definitionDigest, sha256Hex, UNAVAILABLE_HARNESS } from "./agent-definition-schema.mjs";

/** The digested form of one entry: only the fields C3 names, problems sorted. */
function digestedEntry(entry) {
  if (entry.state === "invalid") return { id: entry.id, state: "invalid", problems: [...entry.problems].sort() };
  const digested = {
    id: entry.id,
    state: "valid",
    incarnation: entry.incarnation,
    revision: entry.revision,
    definitionDigest: entry.definitionDigest,
    available: entry.available,
  };
  if (!entry.available) digested.unavailableReason = entry.unavailableReason;
  return digested;
}

/** The canonical bytes: the entries sorted by id (UTF-16 code units), each in its digested form. */
export function snapshotBytes(entries) {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonicalJson(sorted.map(digestedEntry));
}

export const snapshotDigest = (entries) => sha256Hex(snapshotBytes(entries));

/**
 * One snapshot entry from what the store read for an id.
 *
 * @param {{id: string, problems: string[], incarnation?: number, revision?: number, agent?: object}} reading
 *   `problems` empty means valid, and then the ledger's incarnation and revision and the agent are set
 * @param {Set<string>} installed the harnesses whose launchers this host has
 */
export function snapshotEntry(reading, installed) {
  if (reading.problems.length > 0) return { id: reading.id, state: "invalid", problems: [...reading.problems].sort() };
  const available = installed.has(reading.agent.harness);
  return {
    id: reading.id,
    state: "valid",
    incarnation: reading.incarnation,
    revision: reading.revision,
    definitionDigest: definitionDigest(reading.agent),
    definition: reading.agent,
    available,
    ...(available ? {} : { unavailableReason: UNAVAILABLE_HARNESS }),
  };
}
