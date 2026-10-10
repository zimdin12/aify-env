// What a host does with a change request, and whether a start still matches its definition (P0 C4, C7).
//
// PURE: readings in, a decision out. `DefinitionStore.applyRequest` carries the decision out inside
// one lock hold, and the aify-comms plugin asks `startRefusal` at the process-start boundary. Neither
// reads a file or the clock.

/** The service's name for the runtime each harness runs as. The service keeps the same table. */
export const HARNESS_RUNTIME = Object.freeze({ claude: "claude-code", codex: "codex", hermes: "hermes" });

/** A removal is `{"remove": true}` and nothing else (C4). */
export function isRemoval(patch) {
  return patch !== null && typeof patch === "object" && !Array.isArray(patch)
    && Object.keys(patch).length === 1 && patch.remove === true;
}

/**
 * A creation asks for lifetime 0 revision 0, the pair of an agent no store has defined yet (lifetimes and
 * revisions count from 1), and its patch is the whole agent (D8: a spawn of a new id is defined first).
 */
export function isCreation(request) {
  return request.expectedIncarnation === 0 && request.expectedRevision === 0;
}

/** The value a `null` in a patch sets (C4): the schema's neutral value for that field. */
function neutral(field) {
  if (field === "env") return {};
  if (field === "herdrSpace") return true;
  return "";
}

/**
 * The agent a patch makes from `agent` (a JSON merge patch, C4): an absent key is unchanged, `null` sets
 * the neutral value, anything else is the new value. `id` never changes. Validity is C1's question,
 * asked by the store when it writes.
 */
export function mergePatch(agent, patch) {
  const next = { ...agent };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "id") continue;
    next[field] = value === null ? neutral(field) : value;
  }
  return next;
}

/**
 * The `{incarnation, revision}` a trash file name records for `requestId`'s removal of `agentId`, or
 * null. Names are `<id>.<incarnation>.<revision>.<requestId>.<operation>.json`; an id may hold dots, so
 * the name is read from its end.
 */
export function trashedPair(names, agentId, requestId) {
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parts = name.slice(0, -".json".length).split(".");
    if (parts.length < 5) continue;
    const [incarnation, revision, request] = parts.slice(-4, -1);
    if (request === requestId && parts.slice(0, -4).join(".") === agentId) {
      return { incarnation: Number(incarnation), revision: Number(revision) };
    }
  }
  return null;
}

/**
 * C4's apply steps 1 to 4, in order: what to do with `request`, given this store's id, the current
 * reading of its agent (or undefined), and the pair a trash file records for this request's removal
 * (or null).
 *
 * @returns {{verdict: "refused", reason: string} | {verdict: "done", incarnation: number, revision: number}
 *           | {verdict: "apply"}}
 */
export function requestDecision({ request, storeId, current, trashed }) {
  if (request.storeId !== storeId) {
    return { verdict: "refused", reason: `made for another store (${request.storeId}); this host's store is ${storeId}` };
  }
  if (current?.appliedRequest === request.id) {
    return { verdict: "done", incarnation: current.incarnation, revision: current.revision };
  }
  if (isRemoval(request.patch) && trashed) return { verdict: "done", ...trashed };
  if (isCreation(request)) {
    // ANY reading refuses, a hand-written file with problems included: a creation never overwrites a file.
    return current ? { verdict: "refused", reason: `${request.agentId} already exists on this host` } : { verdict: "apply" };
  }
  if (!current || current.incarnation === undefined) {
    return { verdict: "refused", reason: `${request.agentId} is not defined on this host` };
  }
  if (current.problems.length) {
    // Even a removal: the file was edited by hand into something invalid, and a request made against
    // the last good definition is not a decision about what the operator wrote since.
    return { verdict: "refused", reason: `its definition on this host is invalid (${current.problems.join(", ")}); fix it there first` };
  }
  if (current.incarnation !== request.expectedIncarnation || current.revision !== request.expectedRevision) {
    return {
      verdict: "refused",
      reason: `changed on the host since you asked (asked at lifetime ${request.expectedIncarnation} revision `
        + `${request.expectedRevision}; it is now lifetime ${current.incarnation} revision ${current.revision})`,
    };
  }
  return { verdict: "apply" };
}

/**
 * Why a launch must not start, or "" (C7, at the process-start boundary). `listing` is the store's
 * `list()`. A launch the service built without a definition carries `definition: null`, and nothing is
 * checked for it.
 */
export function startRefusal(launch, listing) {
  const bound = launch?.definition;
  if (!bound) return "";
  const id = String(launch.agentId || "");
  if (bound.storeId !== listing.storeId) {
    return `this start was made from store ${bound.storeId}, and this host's store is ${listing.storeId}`;
  }
  const current = listing.definitions.find((reading) => reading.id === id);
  if (!current || current.incarnation === undefined) return `${id} was withdrawn on this host`;
  if (current.problems.length) return `${id}'s definition on this host is invalid (${current.problems.join(", ")})`;
  if (current.incarnation !== bound.incarnation) {
    return `this start was made for an earlier lifetime of ${id} (${bound.incarnation}); it is now ${current.incarnation}`;
  }
  if (current.revision !== bound.revision) {
    return `${id} changed since this start was queued: revision ${bound.revision} -> ${current.revision}; start it again`;
  }
  const runtime = HARNESS_RUNTIME[current.agent.harness];
  if (runtime !== launch.runtime) {
    return `${id}'s harness is ${current.agent.harness} (${runtime}), and this launch runs ${launch.runtime || "nothing"}`;
  }
  return "";
}
