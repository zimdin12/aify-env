#!/usr/bin/env node
// DefinitionStore against a real directory: operations, compare-and-set, hand edits, snapshots, the
// lock. Interruptions are in agent-definition-crash.test.js; the pure decisions in
// agent-definition-recovery.test.js.

import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { definitionBytesProblems, MAX_COUNTER } from "../lib/agent-definition-schema.mjs";
import { DefinitionRefused, DefinitionStore, DefinitionStoreError, processAlive } from "../lib/agent-definitions.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const agent = (over = {}) => ({
  name: "Coder One", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w",
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true, ...over,
});
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-"));
const storeIn = (dir, over = {}) => new DefinitionStore({ dir, lockWaitMs: 300, ...over });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const ledgerOf = (dir) => readJson(path.join(dir, ".collection.json"));
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

test("SET, SET, REMOVE, RECREATE: revisions advance, removal ends the incarnation, trash names stay distinct", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  const first = await store.set("a", agent(), { installed: ALL });
  assert.deepEqual([first.incarnation, first.revision], [1, 1]);
  const file = readJson(path.join(dir, "a.json"));
  assert.equal(file.operation, first.operation, "the file carries its operation's receipt");
  assert.equal(ledgerOf(dir).lastOperation, first.operation, "and so does the ledger");
  const second = await store.set("a", agent({ name: "Renamed" }), { installed: ALL });
  assert.deepEqual([second.incarnation, second.revision], [1, 2]);
  const removed = await store.remove("a");
  assert.equal(removed.trashName, `a.1.2.local.${removed.operation}.json`);
  assert.equal(fs.existsSync(path.join(dir, "a.json")), false);
  const again = await store.set("a", agent(), { installed: ALL });
  assert.deepEqual([again.incarnation, again.revision], [2, 1], "a new lifetime, never incarnation 1 again");
  await store.remove("a");
  assert.equal(fs.readdirSync(path.join(dir, ".trash")).length, 2, "two removals, two trash files");
  assert.equal(fs.existsSync(path.join(dir, ".intent.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".lock")), false, "every call releases its lock");
});

test("IDS THAT NAME OBJECT.PROTOTYPE'S MEMBERS are ordinary ids through the whole lifecycle", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  for (const id of ["constructor", "toString", "hasOwnProperty"]) {
    const made = await store.set(id, agent(), { installed: ALL, expect: null });
    assert.deepEqual([made.incarnation, made.revision], [made.incarnation, 1], `${id} is new, not already defined`);
  }
  fs.writeFileSync(path.join(dir, "valueOf.json"), JSON.stringify({ version: 1, agent: { ...agent(), id: "valueOf" } }));
  const { definitions } = await store.list();
  assert.deepEqual(definitions.map((d) => [d.id, d.incarnation, d.revision]),
    [["constructor", 1, 1], ["hasOwnProperty", 3, 1], ["toString", 2, 1], ["valueOf", 4, 1]]);
  await store.remove("constructor");
  await assert.rejects(store.remove("constructor"), /not defined/, "removed means gone, not the prototype's function");
});

test("COMPARE-AND-SET on (incarnation, revision): a stale pair, a recreated id and a duplicate create are refused", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL, expect: null });
  await assert.rejects(store.set("a", agent(), { installed: ALL, expect: null }), DefinitionRefused);
  await assert.rejects(store.set("a", agent(), { installed: ALL, expect: { incarnation: 1, revision: 9 } }), /changed on the host/);
  await store.remove("a", { expect: { incarnation: 1, revision: 1 } });
  await store.set("a", agent(), { installed: ALL });
  // The same revision number in another lifetime: the incarnation is what refuses it.
  await assert.rejects(store.remove("a", { expect: { incarnation: 1, revision: 1 } }), /changed on the host/);
  assert.ok(fs.existsSync(path.join(dir, "a.json")), "the refused removal left the file");
});

test("A HARNESS WITH NO LAUNCHER, an invalid definition, a bad id and a case twin are refused and write nothing", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await assert.rejects(store.set("a", agent({ harness: "codex" }), { installed: new Set(["claude"]) }), /not installed/);
  await assert.rejects(store.set("a", agent({ name: "" }), { installed: ALL }), (error) => error.problems?.includes("agent.name: length"));
  await assert.rejects(store.set("CON", agent(), { installed: ALL }), /not admitted/);
  await store.set("X", agent(), { installed: ALL });
  await assert.rejects(store.set("x", agent(), { installed: ALL }), /without case/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => !n.startsWith(".")), ["X.json"]);
});

test("HAND EDITS are a second writer: a valid edit is R+1, an invalid one is left as written, a new file is a new id", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  await store.set("b", agent(), { installed: ALL });
  const aFile = path.join(dir, "a.json");
  const edited = readJson(aFile);
  edited.agent.name = "Edited by hand";
  edited.revision = 99; // typed by hand: ignored, the ledger is the authority
  fs.writeFileSync(aFile, JSON.stringify(edited));
  const bFile = path.join(dir, "b.json");
  const invalid = '{"version": 1, "agent": {"id": "b"}}';
  fs.writeFileSync(bFile, invalid);
  fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ version: 1, agent: { ...agent(), id: "c" } }));
  const listed = await store.list();
  const byId = Object.fromEntries(listed.definitions.map((d) => [d.id, d]));
  assert.deepEqual([byId.a.incarnation, byId.a.revision, byId.a.agent.name], [1, 2, "Edited by hand"]);
  assert.equal(readJson(aFile).revision, 2, "rewritten in the store's formatting at R+1");
  assert.ok(byId.b.problems.includes("agent.name: missing"));
  assert.equal(fs.readFileSync(bFile, "utf8"), invalid, "an invalid edit is left exactly as written");
  assert.deepEqual(ledgerOf(dir).ids.b.revision, 1, "the ledger keeps its last good revision");
  assert.deepEqual([byId.c.incarnation, byId.c.revision], [3, 1], "a hand-made file is a new id");
  fs.unlinkSync(path.join(dir, "c.json"));
  const after = await store.list();
  assert.equal(after.definitions.some((d) => d.id === "c"), false);
  assert.equal("c" in ledgerOf(dir).ids, false, "a file removed by hand is a removal");
});

test("A SYMLINK OR JUNCTION ENTRY is invalid and never followed", async (t) => {
  const dir = tempDir();
  const target = tempDir();
  fs.symlinkSync(target, path.join(dir, "j.json"), "junction");
  let fileLink = true;
  try {
    fs.writeFileSync(path.join(target, "real.json"), JSON.stringify({ version: 1, agent: { ...agent(), id: "l" } }));
    fs.symlinkSync(path.join(target, "real.json"), path.join(dir, "l.json"), "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    fileLink = false; // Windows without developer mode cannot make a file symlink; the junction still runs.
    t.diagnostic("file symlink not creatable here (EPERM); junction case only");
  }
  const { definitions } = await storeIn(dir).list();
  const byId = Object.fromEntries(definitions.map((d) => [d.id, d]));
  assert.deepEqual(byId.j.problems, ["entry: not-a-regular-file"]);
  if (fileLink) assert.deepEqual(byId.l.problems, ["entry: not-a-regular-file"]);
  assert.deepEqual(ledgerOf(dir).ids, {}, "nothing behind a link was adopted");
});

test("EVERY FILE THE STORE WRITES is a normalized definition carrying the ledger's identity, adoption included", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  await store.set("a", agent({ name: "Two" }), { installed: ALL });
  // A hand-made file with forged identity: a candidate, adopted with the ledger's numbers.
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ version: 1, incarnation: 42, revision: 9, operation: "forged", agent: { ...agent(), id: "b" } }));
  await store.list();
  const ledger = ledgerOf(dir);
  for (const id of ["a", "b"]) {
    const bytes = fs.readFileSync(path.join(dir, `${id}.json`));
    assert.deepEqual(definitionBytesProblems(bytes, id, { population: "normalized" }).problems, [], `${id}.json is normalized`);
    const body = JSON.parse(bytes);
    assert.deepEqual([body.incarnation, body.revision], [ledger.ids[id].incarnation, ledger.ids[id].revision], `${id}: the ledger's identity`);
  }
  assert.deepEqual([ledger.ids.b.incarnation, ledger.ids.b.revision], [2, 1], "the forged 42/9 were ignored");
});

test("SNAPSHOTS: complete and ordered, and any semantic change -- availability included -- advances the revision", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  const empty = await store.snapshot({ installed: ALL });
  assert.deepEqual([empty.complete, empty.entries], [true, []], "an empty directory is an intentional empty set");
  await store.set("b", agent({ harness: "codex" }), { installed: ALL });
  await store.set("a", agent(), { installed: ALL });
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  const one = await store.snapshot({ installed: ALL });
  assert.deepEqual(one.entries.map((e) => e.id), ["a", "b", "bad"]);
  const two = await store.snapshot({ installed: ALL });
  assert.equal(two.revision, one.revision, "the same state does not advance");
  assert.equal(two.snapshotDigest, one.snapshotDigest);
  const withoutCodex = await store.snapshot({ installed: new Set(["claude"]) });
  assert.equal(withoutCodex.revision, one.revision + 1, "losing a launcher is a change");
  assert.deepEqual(withoutCodex.entries.find((e) => e.id === "b").unavailableReason, "harness-not-installed");
  const back = await store.snapshot({ installed: ALL });
  assert.equal(back.revision, one.revision + 2, "and so is getting it back");
});

test("AN UNREADABLE ENTRY makes the snapshot incomplete, and is never read as a removal", { skip: process.platform !== "win32" && "the deny ACE is Windows'" }, async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  const before = await store.snapshot({ installed: ALL });
  const file = path.join(dir, "a.json");
  const deny = spawnSync("icacls", [file, "/deny", `${os.userInfo().username}:(R)`], { encoding: "utf8" });
  assert.equal(deny.status, 0, `icacls could not deny the read: ${deny.stdout}${deny.stderr}`);
  try {
    assert.throws(() => fs.readFileSync(file), /EPERM|EACCES/, "the control: the file really cannot be read");
    const snap = await store.snapshot({ installed: ALL });
    assert.equal(snap.complete, false);
    assert.deepEqual(snap.incomplete.unreadable, ["a"]);
    assert.equal(snap.revision, before.revision, "an incomplete snapshot records nothing");
    assert.ok("a" in ledgerOf(dir).ids, "an unreadable file is not a removal");
  } finally {
    spawnSync("icacls", [file, "/remove:d", os.userInfo().username]);
  }
  assert.equal((await store.snapshot({ installed: ALL })).complete, true, "and readable again, it is complete");
});

test("THE LOCK: a live holder waits then fails; a dead one on this host is taken over; one on another host is reported", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  const lockPath = path.join(dir, ".lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, atMs: 1, nonce: "live" }));
  await assert.rejects(store.list(), (error) => error instanceof DefinitionStoreError && error.holderAlive === true);
  assert.throws(() => DefinitionStore.unlock({ dir }), /held by running process/);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, "live", "a live holder's lock is never removed");
  const dead = deadPid();
  // An aify-env killed while it held the lock, the way a restart during a defined start leaves it (external
  // review of 0.8.1): the next call takes it over instead of refusing until an operator unlocks it.
  for (const host of [os.hostname(), undefined]) {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, atMs: 1, nonce: "dead", host }));
    assert.equal((await store.list()).definitions.length, 1, `a dead holder on this host is taken over (host ${host ?? "unnamed, as 0.8.1 wrote it"})`);
    assert.equal(fs.existsSync(lockPath), false, "and the taking call releases it");
  }
  // A dead pid on ANOTHER host says nothing about that host's process: still reported, still not taken.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead, atMs: 1, nonce: "elsewhere", host: "another-host" }));
  await assert.rejects(store.list(), (error) => error.holderAlive === false && /aify-env agents unlock/.test(error.message));
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, "elsewhere", "another host's lock is not taken");
  // A torn lock may be a live writer between open and write: never taken.
  fs.writeFileSync(lockPath, "{\"pid\": ");
  await assert.rejects(store.list(), /aify-env agents unlock/);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "{\"pid\": ", "a torn lock is not taken");
  assert.ok(DefinitionStore.unlock({ dir }), "the operator's unlock still clears what the store will not take");
  assert.equal((await store.list()).definitions.length, 1);
});

test("TWO WRITERS RACING: the second waits for the first and then sees its revision", async () => {
  const dir = tempDir();
  await storeIn(dir).set("a", agent(), { installed: ALL });
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    const { DefinitionStore } = await import(${JSON.stringify(new URL("../lib/agent-definitions.mjs", import.meta.url).href)});
    const store = new DefinitionStore({ dir: ${JSON.stringify(dir)}, boundary: (name) => {
      if (name === "intent-written") { process.stdout.write("holding\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); }
    } });
    await store.set("a", ${JSON.stringify(agent({ name: "First" }))}, { installed: new Set(["claude"]) });
  `], { stdio: ["ignore", "pipe", "inherit"] });
  // Listened for at spawn: the holder exits as soon as the second writer's wait ends, which can be
  // before a listener attached after that wait would exist.
  const exited = new Promise((resolve) => holder.on("exit", resolve));
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const second = await storeIn(dir, { lockWaitMs: 5000 }).set("a", agent({ name: "Second" }), { installed: ALL, expect: { incarnation: 1, revision: 2 } });
  assert.equal(second.revision, 3, "it waited, then compared against the first writer's revision 2");
  assert.equal(await exited, 0, "the first writer finished its own set");
});

test("AN EXHAUSTED COUNTER is refused before anything is written", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  await store.set("a", agent(), { installed: ALL });
  const ledger = ledgerOf(dir);
  fs.writeFileSync(path.join(dir, ".collection.json"), JSON.stringify({ ...ledger, nextIncarnation: MAX_COUNTER }));
  const snapshotOfFiles = () => Object.fromEntries(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]));
  const beforeFiles = snapshotOfFiles();
  await assert.rejects(store.set("b", agent(), { installed: ALL }), /exhausted/);
  assert.deepEqual(snapshotOfFiles(), beforeFiles, "a new id needs an incarnation there is no room for");
  await store.set("a", agent({ name: "Still editable" }), { installed: ALL });
  assert.equal(ledgerOf(dir).ids.a.revision, 2, "an existing id spends no incarnation, so it still works");
  fs.writeFileSync(path.join(dir, ".collection.json"), JSON.stringify({ ...ledgerOf(dir), revision: MAX_COUNTER }));
  await assert.rejects(store.set("a", agent(), { installed: ALL }), /exhausted/);
  fs.writeFileSync(path.join(dir, ".collection.json"), JSON.stringify({ ...ledgerOf(dir), revision: MAX_COUNTER + 1 }));
  await assert.rejects(store.list(), /not usable/, "a counter past the safe range is refused, not rounded");
});

test("WHERE THE STORE LIVES: the override, else ~/.aify/agent-definitions (seen from where a default store writes)", () => {
  // The path is not exported, so it is observed: a child makes a default store and defines one agent.
  const storeUrl = new URL("../lib/agent-definitions.mjs", import.meta.url).href;
  const script = `const { DefinitionStore } = await import(${JSON.stringify(storeUrl)});
    await new DefinitionStore().set("a", ${JSON.stringify(agent())}, { installed: new Set(["claude"]) });`;
  const home = tempDir();
  const sealed = { ...process.env, HOME: home, USERPROFILE: home };
  delete sealed.AIFY_AGENT_DEFINITIONS_DIR;
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  const override = path.join(tempDir(), "defs");
  assert.equal(run({ ...sealed, AIFY_AGENT_DEFINITIONS_DIR: override }).status, 0);
  assert.ok(fs.existsSync(path.join(override, "a.json")), "the override is where it wrote");
  assert.equal(fs.existsSync(path.join(home, ".aify", "agent-definitions", "a.json")), false, "and not the home default");
  const byDefault = run(sealed);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.ok(fs.existsSync(path.join(home, ".aify", "agent-definitions", "a.json")), "with no override, the home default");
});

test("WHO COUNTS AS RUNNING", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(deadPid()), false);
  for (const bad of [0, -1, 1.5, "12", null]) assert.equal(processAlive(bad), false, String(bad));
});

test("EDGES: a link entry is not overwritten, an outcome is asked only by operation id, an unreadable intent is not settled", async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  fs.symlinkSync(tempDir(), path.join(dir, "j.json"), "junction");
  await assert.rejects(store.set("j", agent(), { installed: ALL }), /not a regular file/);
  assert.ok(fs.lstatSync(path.join(dir, "j.json")).isSymbolicLink(), "the link is untouched");
  assert.equal(await store.outcomeOf("../../.collection"), null, "a path is not an operation id");
  fs.writeFileSync(path.join(dir, ".intent.json"), "{ torn");
  const listed = await store.list();
  assert.match(listed.conflict.reason, /cannot be read/);
  await assert.rejects(store.settleConflict("committed"), /remove it by hand/);
  assert.equal(fs.readFileSync(path.join(dir, ".intent.json"), "utf8"), "{ torn", "and it is left as found");
});

test("A LOCK TAKEN FROM A RUNNING OPERATION stops it at the next step, and the next open settles it", async () => {
  const dir = tempDir();
  await storeIn(dir).set("a", agent({ name: "Before" }), { installed: ALL });
  const lockPath = path.join(dir, ".lock");
  const thief = storeIn(dir, { boundary: (name) => {
    if (name === "intent-written") fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, atMs: 1, nonce: "someone-else" }));
  } });
  await assert.rejects(thief.set("a", agent({ name: "After" }), { installed: ALL }), /taken from this operation/);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, "someone-else", "the other holder's lock is not released by the aborted call");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8")).agent.name, "Before", "nothing after the intent ran");
  fs.unlinkSync(lockPath);
  const listed = await storeIn(dir).list();
  assert.deepEqual(listed.recovered.map((r) => [r.arm, r.outcome]), [["3", "unknown"]]);
});
