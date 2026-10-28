// What each defined agent runs as, read without changing anything (0.9.9; moved out of agent-definitions.mjs).
//
// The view's read of each definition's harness, model and effort, for a view that refreshes every few seconds
// (lib/view-snapshot.mjs, through DefinitionStore.readOnlySummary, which hands it the store's folder).
//
// STRICTLY READ-ONLY, unlike every store call: no lock, no recovery, no adoption, no folder made, nothing written. A
// view must not be one more writer racing the operator's hand edits. So it reads the ledger and shows a file only when
// its bytes are the ones the ledger adopted: a hand edit stays blank until the daemon's next store call adopts it, and
// a file that does not parse, or a ledger that cannot be read, costs only those fields. Never env or instructions.
//
// IT DOES NOT NAME THE FOLDER: only the store may (tests/agent-definitions-have-one-writer.test.js), so the store
// passes it in and nothing here can be asked for it.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ledgerProblem } from "./agent-definition-recovery.mjs";
import { definitionBytesProblems, idProblems, numberProblems } from "./agent-definition-schema.mjs";

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Each adopted definition in `dir` by id: its harness, model and effort.
 * @param {string} dir  the store's folder, from the store
 * @returns {Map<string, {harness: string, model: string, effort: string}>}  empty when there is no store
 */
export function readDefinitionSummary(dir) {
  const summary = new Map();
  let ledger = null;
  try {
    const text = fs.readFileSync(path.join(dir, ".collection.json"), "utf8");
    if (numberProblems(text).length) return summary;
    ledger = JSON.parse(text);
  } catch {
    return summary;
  }
  if (ledgerProblem(ledger)) return summary;
  for (const [id, known] of Object.entries(ledger.ids)) {
    // An id the ledger names is opened only if it is one the store admits, so a hand-made ledger cannot point outside.
    // NO MUTANT CAN KILL THIS: definitionBytesProblems refuses such an id below, so what is shown is the same either
    // way. What it changes is whether a file outside the folder is opened at all.
    if (idProblems(id).length) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(dir, `${id}.json`));
    } catch {
      continue;
    }
    if (sha256Bytes(bytes) !== known.fileDigest) continue;
    const { problems, body } = definitionBytesProblems(bytes, id);
    if (problems.length) continue;
    const { harness, model, effort } = body.agent;
    summary.set(id, { harness, model, effort });
  }
  return summary;
}
