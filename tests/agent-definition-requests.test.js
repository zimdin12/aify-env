#!/usr/bin/env node
// A change request applied to the store (P0 C4), and a start checked against a definition (C7).
// The pure rules first, each step in its order; then `DefinitionStore.applyRequest` on a real
// directory, read back from the file, the trash and the ledger.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HARNESS_RUNTIME, isCreation, isRemoval, mergePatch, requestDecision, startRefusal, trashedPair,
} from "../lib/agent-definition-requests.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const agent = (over = {}) => ({
  name: "Coder One", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w",
  model: "m1", effort: "high", instructions: "be brief", env: { K: "v" }, herdrSpace: false, ...over,
});
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-requests-"));
const storeIn = (dir) => new DefinitionStore({ dir, lockWaitMs: 300 });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("A MERGE PATCH: absent is unchanged, null is the field's neutral value, the id never moves", () => {
  const before = agent();
  assert.deepEqual(mergePatch(before, { model: "m2" }), { ...before, model: "m2" });
  assert.deepEqual(mergePatch(before, { model: null, env: null, herdrSpace: null }),
    { ...before, model: "", env: {}, herdrSpace: true });
  assert.deepEqual(mergePatch({ ...before, id: "a" }, { id: "b" }), { ...before, id: "a" });
  assert.deepEqual(before, agent(), "the agent passed in is not changed");
});

test("A REMOVAL is {remove: true} and nothing else", () => {
  assert.equal(isRemoval({ remove: true }), true);
  for (const patch of [{ remove: 1 }, { remove: true, model: "x" }, { model: "x" }, null, [], "remove"]) {
    assert.equal(isRemoval(patch), false, JSON.stringify(patch));
  }
});

test("A TRASH NAME is read from its end, so an id with dots is found and a prefix of it is not", () => {
  const names = ["a.b.1.2.req-1.op-x.json", "a.3.4.req-2.op-y.json", "a.b.5.6.local.op-z.json", "notes.txt"];
  assert.deepEqual(trashedPair(names, "a.b", "req-1"), { incarnation: 1, revision: 2 });
  assert.deepEqual(trashedPair(names, "a", "req-2"), { incarnation: 3, revision: 4 });
  assert.equal(trashedPair(names, "a", "req-1"), null, "the request a.b's file names is not a's");
  assert.equal(trashedPair(names, "a.b", "req-9"), null);
});

const request = (over = {}) => ({ id: "req-1", agentId: "a", storeId: "s1", expectedIncarnation: 1, expectedRevision: 2,
  patch: { model: "m2" }, ...over });
const current = (over = {}) => ({ id: "a", problems: [], incarnation: 1, revision: 2, agent: agent(), ...over });

test("THE DECISION takes C4's steps in order", () => {
  const decide = (req, cur, trashed = null) => requestDecision({ request: req, storeId: "s1", current: cur, trashed });
  assert.deepEqual(decide(request({ storeId: "s0" }), current({ appliedRequest: "req-1" })),
    { verdict: "refused", reason: "made for another store (s0); this host's store is s1" }, "1: the store, before anything else");
  assert.deepEqual(decide(request(), current({ revision: 3, appliedRequest: "req-1" })),
    { verdict: "done", incarnation: 1, revision: 3 }, "2: applied already, whatever the pair is now");
  assert.deepEqual(decide(request({ patch: { remove: true } }), undefined, { incarnation: 1, revision: 2 }),
    { verdict: "done", incarnation: 1, revision: 2 }, "3: a removal its trash file records");
  assert.deepEqual(decide(request({ patch: { model: "x" } }), undefined, { incarnation: 1, revision: 2 }),
    { verdict: "refused", reason: "a is not defined on this host" }, "3 is a removal's step only");
  assert.deepEqual(decide(request(), current({ problems: ["agent.model: type"] })),
    { verdict: "refused", reason: "its definition on this host is invalid (agent.model: type); fix it there first" });
  assert.equal(decide(request(), current({ revision: 3 })).reason,
    "changed on the host since you asked (asked at lifetime 1 revision 2; it is now lifetime 1 revision 3)", "4");
  assert.equal(decide(request(), current({ incarnation: 2 })).verdict, "refused", "4: an earlier lifetime, same revision");
  assert.deepEqual(decide(request(), current()), { verdict: "apply" }, "5");
});

const launch = (over = {}) => ({ agentId: "a", runtime: "claude-code",
  definition: { storeId: "s1", incarnation: 1, revision: 2 }, ...over });
const listing = (over = {}) => ({ storeId: "s1", definitions: [current()], ...over });

test("THE START BOUNDARY refuses a start that no longer matches the definition, and checks nothing without one", () => {
  assert.equal(startRefusal(launch({ definition: null }), listing({ definitions: [] })), "", "an undefined agent's launch");
  assert.equal(startRefusal(launch(), listing()), "", "the definition the start was built from");
  assert.equal(startRefusal(launch(), listing({ storeId: "s9" })),
    "this start was made from store s1, and this host's store is s9");
  assert.equal(startRefusal(launch(), listing({ definitions: [] })), "a was withdrawn on this host");
  assert.equal(startRefusal(launch(), listing({ definitions: [current({ problems: ["agent.model: type"] })] })),
    "a's definition on this host is invalid (agent.model: type)");
  assert.equal(startRefusal(launch(), listing({ definitions: [current({ incarnation: 2 })] })),
    "this start was made for an earlier lifetime of a (1); it is now 2");
  assert.equal(startRefusal(launch(), listing({ definitions: [current({ revision: 3 })] })),
    "a changed since this start was queued: revision 2 -> 3; start it again");
  assert.equal(startRefusal(launch({ runtime: "codex" }), listing()),
    "a's harness is claude (claude-code), and this launch runs codex");
  assert.deepEqual(Object.keys(HARNESS_RUNTIME).sort(), [...ALL].sort(), "every harness a definition can name runs as something");
});

test("APPLY a change: the file carries the patch, the next revision and the request; applying it again writes nothing", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  await store.set("a", agent({ name: "Renamed" }), { installed: ALL });
  const { storeId } = await store.list();
  const asked = request({ storeId, patch: { model: "m2", env: null } });
  assert.deepEqual(await store.applyRequest(asked, { installed: ALL }),
    { status: "done", outcome: "", resultIncarnation: 1, resultRevision: 3 });
  const file = readJson(path.join(dir, "a.json"));
  assert.deepEqual([file.revision, file.appliedRequest, file.agent.model, file.agent.env, file.agent.name],
    [3, "req-1", "m2", {}, "Renamed"]);
  const ledgerRevision = readJson(path.join(dir, ".collection.json")).revision;
  assert.deepEqual(await store.applyRequest(asked, { installed: ALL }),
    { status: "done", outcome: "already applied", resultIncarnation: 1, resultRevision: 3 });
  assert.equal(readJson(path.join(dir, ".collection.json")).revision, ledgerRevision, "the repeat wrote nothing");
});

test("APPLY a removal: the trash file names the request, and applying it again is recognised from there", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  const { storeId } = await store.list();
  const asked = request({ storeId, expectedRevision: 1, patch: { remove: true } });
  assert.deepEqual(await store.applyRequest(asked, { installed: ALL }),
    { status: "done", outcome: "", resultIncarnation: 1, resultRevision: 1 });
  assert.equal(fs.existsSync(path.join(dir, "a.json")), false);
  assert.equal(fs.readdirSync(path.join(dir, ".trash")).filter((name) => name.startsWith("a.1.1.req-1.")).length, 1);
  assert.deepEqual(await store.applyRequest(asked, { installed: ALL }),
    { status: "done", outcome: "already applied", resultIncarnation: 1, resultRevision: 1 });
});

test("A CREATION (lifetime 0 revision 0, D8) applies only where no file names the id", () => {
  const decide = (cur) => requestDecision({ request: request({ expectedIncarnation: 0, expectedRevision: 0, patch: agent() }),
    storeId: "s1", current: cur, trashed: null });
  assert.equal(isCreation(request({ expectedIncarnation: 0, expectedRevision: 0 })), true);
  assert.equal(isCreation(request({ expectedIncarnation: 0, expectedRevision: 1 })), false, "both counters say so, not one");
  assert.deepEqual(decide(undefined), { verdict: "apply" });
  assert.deepEqual(decide(current()), { verdict: "refused", reason: "a already exists on this host" });
  assert.equal(decide({ id: "a", problems: ["entry: not-adopted"] }).verdict, "refused", "a hand-written file is not overwritten");
  assert.deepEqual(decide(current({ appliedRequest: "req-1" })), { verdict: "done", incarnation: 1, revision: 2 },
    "the creation applied already is done, not refused as existing");
});

test("APPLY a creation: the file is the whole agent at a new lifetime, revision 1; applying it again writes nothing", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("other", agent(), { installed: ALL });
  const { storeId } = await store.list();
  const asked = request({ storeId, agentId: "b", expectedIncarnation: 0, expectedRevision: 0, patch: agent({ name: "New" }) });
  assert.deepEqual(await store.applyRequest(asked, { installed: ALL }),
    { status: "done", outcome: "", resultIncarnation: 2, resultRevision: 1 });
  const file = readJson(path.join(dir, "b.json"));
  assert.deepEqual([file.incarnation, file.revision, file.appliedRequest, file.agent],
    [2, 1, "req-1", { ...agent({ name: "New" }), id: "b" }]);
  const ledgerRevision = readJson(path.join(dir, ".collection.json")).revision;
  assert.deepEqual(await store.applyRequest(asked, { installed: ALL }),
    { status: "done", outcome: "already applied", resultIncarnation: 2, resultRevision: 1 });
  assert.equal(readJson(path.join(dir, ".collection.json")).revision, ledgerRevision, "the repeat wrote nothing");
  const again = await store.applyRequest({ ...asked, id: "req-2" }, { installed: ALL });
  assert.deepEqual(again, { status: "refused", outcome: "b already exists on this host" }, "a second creation of the id");
  assert.equal(readJson(path.join(dir, "b.json")).appliedRequest, "req-1", "and it wrote nothing");
});

test("APPLY refuses, writing nothing: another store, a host edit since, an invalid result, an uninstalled harness", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  const { storeId } = await store.list();
  const refused = async (req, installed = ALL) => {
    const before = fs.readFileSync(path.join(dir, "a.json"), "utf8");
    const answer = await store.applyRequest({ ...request({ storeId, expectedRevision: 1 }), ...req }, { installed });
    assert.equal(fs.readFileSync(path.join(dir, "a.json"), "utf8"), before, "the file is unchanged");
    assert.equal(answer.status, "refused");
    return answer.outcome;
  };
  assert.match(await refused({ storeId: "elsewhere" }), /^made for another store/);
  assert.match(await refused({ patch: { harness: "nope" } }), /^the definition is not valid \(.*agent\.harness/);
  assert.equal(await refused({ patch: { harness: "codex" } }, new Set(["claude"])),
    "the codex launcher is not installed on this host");
  await store.set("a", agent({ model: "edited by hand" }), { installed: ALL });
  assert.match(await refused({}), /^changed on the host since you asked/);
});
