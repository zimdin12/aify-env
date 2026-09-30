#!/usr/bin/env node
// P0 C2's recovery table and adoption rules, as pure decisions. The store's own tests prove it
// observes the disk and carries these out; these prove the decisions are the table's.

import assert from "node:assert/strict";
import test from "node:test";

import { adoptionPlan, caseCollisions, ledgerEntry, recoveryDecision } from "../lib/agent-definition-recovery.mjs";

const OP = "op-2";
const intent = (over = {}) => ({ operation: OP, op: "set", id: "a", before: "digest-before", ...over });
const seen = (over = {}) => ({ ledgerLastOperation: "op-1", file: { present: true, digest: "digest-before", operation: "op-1" }, trashHasOperation: false, ...over });
const decide = (i, r, s) => recoveryDecision(i, r, s);

test("ARM 1: the ledger carries the operation, so it committed through step 3", () => {
  assert.deepEqual(decide(intent(), null, seen({ ledgerLastOperation: OP })), { arm: "1", outcome: "committed", settle: "finish", writeLedger: null });
});

test("ARM 2: the file or the trash carries the operation, so it committed at step 2", () => {
  const onFile = decide(intent(), null, seen({ file: { present: true, digest: "x", operation: OP } }));
  assert.deepEqual(onFile, { arm: "2", outcome: "committed", settle: "finish", writeLedger: "after" });
  const inTrash = decide(intent({ op: "remove" }), null, seen({ file: { present: false }, trashHasOperation: true }));
  assert.equal(inTrash.arm, "2");
  // A removal's receipt is its trash name, never a file body: a file carrying the id is not one.
  const wrongCarrier = decide(intent({ op: "remove" }), null, seen({ file: { present: true, digest: "y", operation: OP } }));
  assert.equal(wrongCarrier.arm, "4");
});

test("ARM 3: exactly the before state and no receipt is UNKNOWN, settled forward, never not-committed", () => {
  for (const [name, i, s] of [
    ["an existing id's before bytes", intent(), seen()],
    ["a new id still absent", intent({ before: "absent" }), seen({ file: { present: false } })],
    ["a removal whose file is there", intent({ op: "remove" }), seen()],
  ]) {
    assert.deepEqual(decide(i, null, s), { arm: "3", outcome: "unknown", settle: "forward", writeLedger: "after" }, name);
  }
});

test("ARM 4: anything else is a conflict that writes nothing", () => {
  for (const [name, i, s] of [
    ["changed bytes, receipt gone", intent(), seen({ file: { present: true, digest: "hand", operation: null } })],
    ["an existing id's file deleted", intent(), seen({ file: { present: false } })],
    ["a new id's file present without a receipt", intent({ before: "absent" }), seen({ file: { present: true, digest: "d", operation: null } })],
    ["another operation's receipt", intent(), seen({ file: { present: true, digest: "d", operation: "op-9" } })],
  ]) {
    assert.deepEqual(decide(i, null, s), { arm: "4", outcome: "conflict", settle: "conflict", writeLedger: null }, name);
  }
});

test("A RECORD IS READ FIRST: the settlement's own ledger receipt never turns unknown into committed", () => {
  const record = { outcome: "unknown" };
  // The crash came after the forward settlement wrote the ledger: arm 1's evidence is present.
  assert.deepEqual(decide(intent(), record, seen({ ledgerLastOperation: OP })), { arm: "record", outcome: "unknown", settle: "finish", writeLedger: null });
  // Before it did: the settlement is finished by writing the ledger.
  assert.deepEqual(decide(intent(), record, seen()), { arm: "record", outcome: "unknown", settle: "finish", writeLedger: "after" });
  // The operator's choices carry through the same way.
  assert.equal(decide(intent(), { outcome: "not-committed" }, seen()).writeLedger, "not-committed");
  assert.equal(decide(intent(), { outcome: "committed" }, seen()).outcome, "committed");
});

test("AN OBSERVE has no step 2: arm 1, or arm 2's outcome", () => {
  assert.equal(decide(intent({ op: "observe", before: "absent" }), null, seen({ ledgerLastOperation: OP })).arm, "1");
  assert.deepEqual(decide(intent({ op: "observe", before: "absent" }), null, seen({ file: { present: false } })),
    { arm: "2", outcome: "committed", settle: "finish", writeLedger: "after" });
});

test("ADOPTION: a changed valid file is R+1, a new one a new incarnation, a missing one a removal", () => {
  const ledger = { nextIncarnation: 7, ids: { kept: { incarnation: 1, revision: 3, fileDigest: "k" }, edited: { incarnation: 2, revision: 5, fileDigest: "e0" }, gone: { incarnation: 3, revision: 1, fileDigest: "g" }, broken: { incarnation: 4, revision: 2, fileDigest: "b0" }, locked: { incarnation: 5, revision: 1, fileDigest: "l" } } };
  const files = new Map([
    ["kept", { digest: "k", valid: true }],
    ["edited", { digest: "e1", valid: true }],
    ["broken", { digest: "b1", valid: false }],
    ["new-b", { digest: "n", valid: true }],
    ["new-a", { digest: "m", valid: true }],
    ["junk", { digest: "j", valid: false }],
  ]);
  assert.deepEqual(adoptionPlan(ledger, files, new Set(["locked"])), [
    { kind: "adopt", id: "edited", incarnation: 2, revision: 6 },
    { kind: "hand-removal", id: "gone" },
    { kind: "new", id: "new-a", incarnation: 7, revision: 1 },
    { kind: "new", id: "new-b", incarnation: 8, revision: 1 },
  ]);
});

test("CASE COLLISIONS: the one the ledger holds keeps it, the others are refused", () => {
  assert.deepEqual([...caseCollisions(["X", "x", "y"], { X: {} })], ["x"]);
  assert.deepEqual([...caseCollisions(["X", "x"], {})].sort(), ["X", "x"]);
  assert.deepEqual([...caseCollisions(["X", "x"], { X: {}, x: {} })].sort(), ["X", "x"]);
  assert.deepEqual([...caseCollisions(["a", "b"], {})], []);
});

test("A LEDGER ENTRY is an own property: Object.prototype's members are not agents", () => {
  const ids = JSON.parse('{"a": {"incarnation": 1}}');
  assert.deepEqual(ledgerEntry(ids, "a"), { incarnation: 1 });
  for (const name of ["constructor", "toString", "hasOwnProperty", "missing"]) assert.equal(ledgerEntry(ids, name), undefined, name);
});
