#!/usr/bin/env node
// P0 C2's interruption witnesses, for real: a child process runs one store call and kills itself at a
// named durable step (fixtures/agent-definitions/crash-at.mjs), leaving its lock, intent and half-done
// work exactly as a crash would. The operator's `unlock` then clears the dead holder's lock, and the
// next open must settle the operation and leave ledger, file, trash and `.recovered/` agreeing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DefinitionStore } from "../lib/agent-definitions.mjs";

const CRASH_AT = fileURLToPath(new URL("./fixtures/agent-definitions/crash-at.mjs", import.meta.url));
const ALL = new Set(["claude", "codex", "hermes"]);
const agent = (name) => ({ name, role: "coder", harness: "claude", mode: "managed", workspace: "C:/w", model: "", effort: "", instructions: "", env: {}, herdrSpace: true });
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-crash-"));
const file = (dir, ...parts) => path.join(dir, ...parts);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const ledgerOf = (dir) => readJson(file(dir, ".collection.json"));

/** Run one call in a child that dies at `crashAt`; returns the interrupted operation's id. */
function crash(dir, spec) {
  const run = spawnSync(process.execPath, [CRASH_AT, dir, JSON.stringify(spec)], { encoding: "utf8" });
  assert.notEqual(run.status, 0, `the child finished without reaching ${spec.crashAt.name}: nothing was interrupted`);
  assert.equal(run.stderr.includes("Error"), false, `the child failed instead of crashing: ${run.stderr}`);
  const holder = DefinitionStore.unlock({ dir });
  assert.ok(holder, "a crashed call leaves its lock, which only the operator's unlock clears");
  const intent = fs.existsSync(file(dir, ".intent.json")) ? readJson(file(dir, ".intent.json")) : null;
  return intent?.operation ?? ledgerOf(dir).lastOperation;
}

/** A store holding `a` at revision 1 named "Before"; returns the store and the file's bytes. */
async function withBefore() {
  const dir = tempDir();
  const store = new DefinitionStore({ dir });
  await store.set("a", agent("Before"), { installed: ALL });
  return { dir, store, before: fs.readFileSync(file(dir, "a.json")) };
}

/** The settled state, with the outcome the recovering call RETURNED (the ledger's receipt is gone by then). */
async function stateOf(store, dir, operation) {
  const listed = await store.list();
  const settled = listed.recovered.find((r) => r.operation === operation);
  return {
    outcome: settled ? settled.outcome : await store.outcomeOf(operation),
    a: listed.definitions.find((d) => d.id === "a") ?? null,
    intent: fs.existsSync(file(dir, ".intent.json")),
    record: fs.existsSync(file(dir, ".recovered", `${operation}.json`)) ? readJson(file(dir, ".recovered", `${operation}.json`)) : null,
    body: fs.existsSync(file(dir, ".recovered", `${operation}.body.json`)),
  };
}

test("A TORN SET, at every step: committed from step 2 on, unknown and settled forward before it", async () => {
  const expected = {
    "intent-written": { outcome: "unknown", revision: 3, name: "Before", body: false },
    "temp-written": { outcome: "unknown", revision: 3, name: "Before", body: true },
    applied: { outcome: "committed", revision: 2, name: "After", body: false },
    "ledger-written": { outcome: "committed", revision: 2, name: "After", body: false },
    "intent-deleted": { outcome: "committed", revision: 2, name: "After", body: false },
  };
  for (const [step, want] of Object.entries(expected)) {
    const { dir, store } = await withBefore();
    const operation = crash(dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: step, op: "set" } });
    const got = await stateOf(store, dir, operation);
    assert.deepEqual({ outcome: got.outcome, revision: got.a.revision, name: got.a.agent.name, body: got.body },
      want, `crash at ${step}`);
    assert.equal(got.intent, false, `${step}: the intent is settled`);
    assert.equal(got.a.incarnation, 1, `${step}: the same lifetime`);
    assert.equal(got.record?.outcome ?? null, want.outcome === "unknown" ? "unknown" : null, `${step}: a record exactly when unproven`);
    assert.equal(ledgerOf(dir).ids.a.fileDigest.length, 64);
  }
});

test("A TORN REMOVE and a TORN CREATE settle the same way, and never reuse an incarnation", async () => {
  for (const [step, want] of [["intent-written", "unknown"], ["applied", "committed"], ["ledger-written", "committed"]]) {
    const { dir, store } = await withBefore();
    const operation = crash(dir, { call: "remove", id: "a", crashAt: { name: step, op: "remove" } });
    const got = await stateOf(store, dir, operation);
    assert.equal(got.outcome, want, `remove, crash at ${step}`);
    if (want === "committed") assert.equal(got.a, null, `${step}: removed`);
    else assert.deepEqual([got.a.incarnation, got.a.revision], [2, 1], `${step}: its file is still there, so it is a new lifetime`);
  }
  for (const [step, want] of [["intent-written", "unknown"], ["applied", "committed"]]) {
    const dir = tempDir();
    const store = new DefinitionStore({ dir });
    const operation = crash(dir, { call: "set", id: "a", agent: agent("New"), crashAt: { name: step, op: "set" } });
    const got = await stateOf(store, dir, operation);
    assert.equal(got.outcome, want, `create, crash at ${step}`);
    const next = await store.set("z", agent("Next"), { installed: ALL });
    assert.equal(next.incarnation, 2, `create, crash at ${step}: incarnation 1 was handed out and is never reused`);
  }
});

test("A CRASH INSIDE THE FORWARD SETTLEMENT keeps UNKNOWN; an ordinary receipt still reads COMMITTED", async () => {
  for (const step of ["recovered-record-written", "settle-ledger-written", "settle-intent-deleted"]) {
    const { dir, store } = await withBefore();
    const operation = crash(dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: "intent-written", op: "set" } });
    crash(dir, { call: "list", crashAt: { name: step } });
    const got = await stateOf(store, dir, operation);
    assert.equal(got.outcome, "unknown", `crash at ${step}: the settlement's own ledger receipt is not evidence`);
    assert.deepEqual([got.a.revision, got.a.agent.name], [3, "Before"], `${step}: adopted as R+1`);
    assert.equal(got.record.outcome, "unknown", `${step}: the record is never rewritten`);
  }
  const { dir, store } = await withBefore();
  const operation = crash(dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: "ledger-written", op: "set" } });
  const got = await stateOf(store, dir, operation);
  assert.deepEqual([got.outcome, got.record], ["committed", null], "the positive control: arm 1 with no record");
});

test("THE BEFORE BYTES PUT BACK after step 2 settle exactly like a crash before it", async () => {
  const restored = await withBefore();
  const restoredOp = crash(restored.dir, { call: "set", id: "a", agent: agent("After"), options: { requestId: "req-7" }, crashAt: { name: "applied", op: "set" } });
  fs.writeFileSync(file(restored.dir, "a.json"), restored.before);
  const early = await withBefore();
  const earlyOp = crash(early.dir, { call: "set", id: "a", agent: agent("After"), options: { requestId: "req-7" }, crashAt: { name: "intent-written", op: "set" } });
  const a = await stateOf(restored.store, restored.dir, restoredOp);
  const b = await stateOf(early.store, early.dir, earlyOp);
  for (const got of [a, b]) {
    assert.deepEqual([got.outcome, got.a.revision, got.a.agent.name], ["unknown", 3, "Before"]);
    assert.equal(got.record.requestId, "req-7", "the request's id survives in the record");
  }
  // Its replay carries the pair it was made against, which has moved: refused (C4 step 4).
  for (const { store } of [restored, early]) {
    await assert.rejects(store.set("a", agent("After"), { installed: ALL, expect: { incarnation: 1, revision: 1 }, requestId: "req-7" }),
      /changed on the host/);
  }
  // Each store was written at its own time, so each record's `before` is its own before bytes' digest.
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(a.record.before, digest(restored.before));
  assert.equal(b.record.before, digest(early.before));
  const shape = ({ operation: _op, before: _before, tempName: _temp, ledgerAfter, ...rest }) => ({ ...rest, ledgerIds: Object.keys(ledgerAfter.ids) });
  assert.deepEqual(shape(a.record), shape(b.record), "the two histories are recorded identically");
});

test("A NEW ID CREATED THEN DELETED BY HAND settles like one never created: absent, its incarnation spent", async () => {
  for (const [step, edit] of [["applied", (dir) => fs.unlinkSync(file(dir, "a.json"))], ["intent-written", () => {}]]) {
    const dir = tempDir();
    const store = new DefinitionStore({ dir });
    const operation = crash(dir, { call: "set", id: "a", agent: agent("New"), crashAt: { name: step, op: "set" } });
    edit(dir);
    const got = await stateOf(store, dir, operation);
    assert.deepEqual([got.outcome, got.a], ["unknown", null], `${step}`);
    assert.equal((await store.set("a", agent("Again"), { installed: ALL })).incarnation, 2, `${step}: incarnation 1 is spent`);
  }
});

test("A REMOVAL MOVED BACK FROM THE TRASH by hand is a file made by hand: a new incarnation", async () => {
  const { dir, store } = await withBefore();
  const operation = crash(dir, { call: "remove", id: "a", crashAt: { name: "applied", op: "remove" } });
  const [trashed] = fs.readdirSync(file(dir, ".trash"));
  fs.renameSync(file(dir, ".trash", trashed), file(dir, "a.json"));
  const got = await stateOf(store, dir, operation);
  assert.equal(got.outcome, "unknown");
  assert.deepEqual([got.a.incarnation, got.a.revision, got.a.agent.name], [2, 1, "Before"]);
});

test("HAND EDITS AFTER A CRASH: a receipt keeps the lineage, set at R then the edit at R+1", async () => {
  const edit = (dir) => {
    const body = readJson(file(dir, "a.json"));
    body.agent.name = "By hand";
    fs.writeFileSync(file(dir, "a.json"), JSON.stringify(body));
  };
  for (const [step, arm] of [["applied", "2"], ["ledger-written", "1"]]) {
    const { dir, store } = await withBefore();
    const operation = crash(dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: step, op: "set" } });
    edit(dir);
    const got = await stateOf(store, dir, operation);
    assert.deepEqual([got.outcome, got.a.revision, got.a.agent.name], ["committed", 3, "By hand"], `arm ${arm}`);
  }
});

test("A RECEIPT REMOVED BY HAND is a conflict: everything kept, snapshots incomplete, until the operator settles it", async () => {
  for (const choice of ["committed", "not-committed"]) {
    const { dir, store } = await withBefore();
    const operation = crash(dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: "applied", op: "set" } });
    const body = readJson(file(dir, "a.json"));
    delete body.operation;
    body.agent.name = "No receipt";
    fs.writeFileSync(file(dir, "a.json"), JSON.stringify(body));
    const bytes = fs.readFileSync(file(dir, "a.json"));
    assert.equal((await store.list()).conflict?.intent?.operation, operation, "list shows the conflict");
    await assert.rejects(store.set("a", agent("Refused"), { installed: ALL }), /conflict/);
    const snap = await store.snapshot({ installed: ALL });
    assert.equal(snap.complete, false, "nothing is pushed and nothing is withdrawn");
    assert.ok(fs.existsSync(file(dir, ".intent.json")), "the intent is kept");
    assert.deepEqual(fs.readFileSync(file(dir, "a.json")), bytes, "the file is kept exactly");
    await store.settleConflict(choice);
    const got = await stateOf(store, dir, operation);
    assert.equal(got.outcome, choice, "the operator's choice is the outcome");
    assert.equal(got.record.settledBy, "operator");
    assert.equal(got.a.agent.name, "No receipt", "the file on disk is adopted either way");
    assert.equal(got.a.revision, choice === "committed" ? 3 : 2);
  }
});

test("AN EXISTING ID'S FILE DELETED BEFORE RECOVERY: a conflict without the ledger receipt, a removal with it", async () => {
  const early = await withBefore();
  crash(early.dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: "applied", op: "set" } });
  fs.unlinkSync(file(early.dir, "a.json"));
  assert.ok((await early.store.list()).conflict, "a conflict");
  await assert.rejects(early.store.remove("a"), /conflict/, "and operations refuse");
  const late = await withBefore();
  const operation = crash(late.dir, { call: "set", id: "a", agent: agent("After"), crashAt: { name: "ledger-written", op: "set" } });
  fs.unlinkSync(file(late.dir, "a.json"));
  const got = await stateOf(late.store, late.dir, operation);
  assert.deepEqual([got.outcome, got.a], ["committed", null], "arm 1, then adoption reads the deletion as a removal");
  assert.equal("a" in ledgerOf(late.dir).ids, false);
});

test("A NEW ID SETTLED NOT-COMMITTED BY THE OPERATOR still spends the incarnation it was handed", async () => {
  const dir = tempDir();
  const store = new DefinitionStore({ dir });
  crash(dir, { call: "set", id: "a", agent: agent("New"), crashAt: { name: "applied", op: "set" } });
  const body = readJson(file(dir, "a.json"));
  delete body.operation;
  fs.writeFileSync(file(dir, "a.json"), JSON.stringify(body));
  assert.ok((await store.list()).conflict, "no receipt on a file the before state lacked: a conflict");
  await store.settleConflict("not-committed");
  const { definitions } = await store.list();
  assert.deepEqual(definitions.map((d) => [d.id, d.incarnation]), [["a", 2]], "the file is adopted as a new id, after incarnation 1");
  assert.equal((await store.set("b", agent("B"), { installed: ALL })).incarnation, 3);
});
