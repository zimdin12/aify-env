// What recovery and adoption must do, decided from what is on disk (P0 C2). PURE: the store reads
// the directory, these decide, the store carries the decision out. Keeping the decisions here is what
// lets every arm be driven exhaustively without a filesystem, and the store's own tests then prove
// only that it observes and executes faithfully.

/**
 * The ledger's entry for an id, looked up as an OWN property. `constructor`, `toString` and
 * `hasOwnProperty` are valid agent ids, and a plain `ids[id]` finds Object.prototype's function for
 * them: an agent nobody defined would read as defined.
 */
export const ledgerEntry = (ids, id) => (Object.hasOwn(ids, id) ? ids[id] : undefined);

/**
 * The recovery decision for one interrupted operation.
 *
 * @param {object} intent the `.intent.json` found: {operation, op, before, ...}
 * @param {object|null} record `.recovered/<operation>.json`, when one exists
 * @param {{ledgerLastOperation: string|null, file: {present: boolean, digest?: string, operation?: string|null},
 *          trashHasOperation: boolean}} seen what the store observed
 * @returns {{arm: string, outcome: string, settle: "finish"|"forward"|"conflict", writeLedger: "after"|"not-committed"|null}}
 *   `finish` completes the bookkeeping (write the ledger named by `writeLedger` unless it is already
 *   there, then delete the intent); `forward` is arm 3's settlement; `conflict` touches nothing.
 */
export function recoveryDecision(intent, record, seen) {
  const committedThroughLedger = seen.ledgerLastOperation === intent.operation;
  // A RECORD IS READ FIRST. After a forward or operator settlement the ledger may carry this
  // operation's id, but that receipt was written by the settlement: it is bookkeeping, not evidence
  // that the original step 2 ran, so it must not turn the recorded outcome into "committed".
  if (record) {
    const notCommitted = record.outcome === "not-committed";
    return {
      arm: "record",
      outcome: record.outcome,
      settle: "finish",
      writeLedger: committedThroughLedger ? null : notCommitted ? "not-committed" : "after",
    };
  }
  if (committedThroughLedger) return { arm: "1", outcome: "committed", settle: "finish", writeLedger: null };
  // An observe changes only the ledger: there is no step 2 whose receipt could be missing.
  if (intent.op === "observe") return { arm: "2", outcome: "committed", settle: "finish", writeLedger: "after" };
  const receiptOnFile = intent.op === "set" && seen.file.present && seen.file.operation === intent.operation;
  const receiptInTrash = intent.op === "remove" && seen.trashHasOperation;
  if (receiptOnFile || receiptInTrash) return { arm: "2", outcome: "committed", settle: "finish", writeLedger: "after" };
  const stateIsBefore = intent.before === "absent" ? !seen.file.present : seen.file.present && seen.file.digest === intent.before;
  if (stateIsBefore && !seen.trashHasOperation) {
    // Step 2 never ran, or it ran and the before state was put back by hand: the bytes cannot say
    // which, so the outcome is unknown and the settlement is the one true of both.
    return { arm: "3", outcome: "unknown", settle: "forward", writeLedger: "after" };
  }
  return { arm: "4", outcome: "conflict", settle: "conflict", writeLedger: null };
}

/**
 * What the adoption pass must do to bring the ledger level with the directory.
 *
 * @param {{ids: object, nextIncarnation: number}} ledger
 * @param {Map<string, {digest: string, valid: boolean}>} files every definition file read cleanly,
 *   by id (unreadable ones are left out by the caller, which then reports the snapshot incomplete)
 * @param {Set<string>} unreadable ids whose file exists but could not be read: never a removal
 * @returns {Array<{kind: "adopt"|"new"|"hand-removal", id: string, incarnation?: number, revision?: number}>}
 *   in id order. An invalid changed file is not an action: it is left as written and the ledger keeps
 *   the last good incarnation and revision.
 */
export function adoptionPlan(ledger, files, unreadable = new Set()) {
  const actions = [];
  const ids = [...new Set([...Object.keys(ledger.ids), ...files.keys()])].sort();
  let nextIncarnation = ledger.nextIncarnation;
  for (const id of ids) {
    const known = ledgerEntry(ledger.ids, id);
    const file = files.get(id);
    if (!file) {
      if (known && !unreadable.has(id)) actions.push({ kind: "hand-removal", id });
      continue;
    }
    if (!file.valid) continue;
    if (!known) {
      actions.push({ kind: "new", id, incarnation: nextIncarnation, revision: 1 });
      nextIncarnation += 1;
    } else if (file.digest !== known.fileDigest) {
      actions.push({ kind: "adopt", id, incarnation: known.incarnation, revision: known.revision + 1 });
    }
  }
  return actions;
}

/**
 * Which files are refused for sharing a lower-case id with another (C1: the directory must mean the
 * same thing on Windows and Linux). One that already has a ledger entry keeps it; the others are
 * refused. When none or several do, all of them are.
 */
export function caseCollisions(fileIds, ledgerIds) {
  const groups = new Map();
  for (const id of fileIds) {
    const key = id.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const refused = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const owners = group.filter((id) => ledgerEntry(ledgerIds, id) !== undefined);
    for (const id of group) if (owners.length !== 1 || owners[0] !== id) refused.add(id);
  }
  return refused;
}
