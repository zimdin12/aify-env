#!/usr/bin/env node
// The review of P1 at 3aa5df7 (comms-senior-dev, 2026-10-01): one regression per finding, each watched
// RED against that commit before its repair. R8 (the one-writer gate) is in
// agent-definitions-have-one-writer.test.js; the canonical-order gap is a shared-fixture vector.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAgentsArgs, runAgents } from "../bin/aify-env-agents.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const COMMAND = fileURLToPath(new URL("../bin/aify-env-agents.mjs", import.meta.url));
const LAUNCHER = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
const agent = (over = {}) => ({
  name: "Coder One", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w",
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true, ...over,
});
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-review-"));
const storeIn = (dir, over = {}) => new DefinitionStore({ dir, lockWaitMs: 300, ...over });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const ledgerOf = (dir) => readJson(path.join(dir, ".collection.json"));

test("R1 A LOCK LOST BETWEEN RENAME RETRIES stops the apply before it happens; an untouched retry still succeeds", async () => {
  const dir = tempDir();
  await storeIn(dir).set("a", agent({ name: "Before" }), { installed: ALL });
  const lockPath = path.join(dir, ".lock");
  const busyOnce = (steal) => {
    let refused = false;
    return (from, to) => {
      if (!refused && path.basename(to) === "a.json") {
        refused = true;
        if (steal) fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, atMs: 1, nonce: "thief" }));
        throw Object.assign(new Error("in use"), { code: "EPERM" });
      }
      return fs.renameSync(from, to);
    };
  };
  await assert.rejects(storeIn(dir, { renameSync: busyOnce(true) }).set("a", agent({ name: "After" }), { installed: ALL }), /taken from this operation/);
  assert.equal(readJson(path.join(dir, "a.json")).agent.name, "Before", "the retry did not apply under the other lock");
  fs.unlinkSync(lockPath);
  await storeIn(dir).list();
  await storeIn(dir, { renameSync: busyOnce(false) }).set("a", agent({ name: "Retried" }), { installed: ALL });
  assert.equal(readJson(path.join(dir, "a.json")).agent.name, "Retried", "control: a refused-then-granted rename completes");
});

test("R2 THE LEDGER'S COUNTERS obey the raw-number law: a fraction, an exponent, past the safe range", async () => {
  const dir = tempDir();
  await storeIn(dir).set("a", agent(), { installed: ALL });
  const ledgerPath = path.join(dir, ".collection.json");
  const good = fs.readFileSync(ledgerPath, "utf8");
  const withRevision = (literal) => good.replace(/("storeId": "[^"]+",\s*"revision": )\d+/, `$1${literal}`);
  assert.notEqual(withRevision("7"), good, "the splice found the collection revision");
  for (const literal of ["9007199254740990.5", "2e0", "9007199254740992"]) {
    fs.writeFileSync(ledgerPath, withRevision(literal));
    await assert.rejects(storeIn(dir).list(), /not usable: file: (non-integer-number|unsafe-integer)/, literal);
  }
  fs.writeFileSync(ledgerPath, withRevision("9007199254740990"));
  assert.equal((await storeIn(dir).list()).revision, 9007199254740990, "control: an exact safe integer is read as written");
});

test("R3 A KNOWN FILE REPLACED BY A DIRECTORY OR A JUNCTION is invalid, not removed: repaired, it keeps its identity", async () => {
  const cases = [["directory", (p) => fs.mkdirSync(p)], ["junction", (p) => fs.symlinkSync(tempDir(), p, "junction")]];
  for (const [kind, replace] of cases) {
    const dir = tempDir();
    const store = storeIn(dir);
    await store.set("a", agent(), { installed: ALL });
    const file = path.join(dir, "a.json");
    const bytes = fs.readFileSync(file);
    fs.unlinkSync(file);
    replace(file);
    const listed = await store.list();
    assert.equal(ledgerOf(dir).ids.a?.incarnation, 1, `${kind}: the ledger keeps its last good identity`);
    assert.deepEqual(listed.definitions.map((d) => [d.id, d.problems, d.incarnation]), [["a", ["entry: not-a-regular-file"], 1]], kind);
    fs.rmSync(file, { recursive: true, force: true });
    fs.writeFileSync(file, bytes);
    const repaired = (await store.list()).definitions[0];
    assert.deepEqual([repaired.incarnation, repaired.revision], [1, 1], `${kind}: repaired, it is the same lifetime`);
  }
});

test("R4 ENV KEYS NAMING OBJECT.PROTOTYPE MEMBERS reach the written file through the command, and unset", () => {
  const root = tempDir();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude-aify"), LAUNCHER);
  const defs = path.join(root, "defs");
  const env = { ...process.env, PATH: bin, AIFY_AGENT_DEFINITIONS_DIR: defs };
  const run = (...args) => spawnSync(process.execPath, [COMMAND, ...args], { env, encoding: "utf8" });
  const made = run("set", "a", "name=A", "role=r", "harness=claude", "mode=managed", "workspace=C:/w",
    "env.__proto__=p", "env.constructor=c", "env.toString=t");
  assert.equal(made.status, 0, made.stderr);
  const written = () => readJson(path.join(defs, "a.json")).agent.env;
  assert.deepEqual(Object.keys(written()).sort(), ["__proto__", "constructor", "toString"]);
  assert.equal(Object.getOwnPropertyDescriptor(written(), "__proto__").value, "p");
  assert.equal(run("set", "a", "-env.__proto__").status, 0);
  assert.deepEqual(Object.keys(written()).sort(), ["constructor", "toString"]);
});

test("R5 A SET RACED BETWEEN ITS READ AND ITS WRITE is refused, never a stale full-body overwrite", async () => {
  const dir = tempDir();
  const installed = new Set(["claude"]);
  const real = storeIn(dir);
  await real.set("a", agent({ name: "A" }), { installed });
  const racing = {
    list: async () => {
      const seen = await real.list();
      await storeIn(dir).set("a", agent({ name: "A", model: "concurrent-model" }), { installed });
      return seen;
    },
    set: (...args) => real.set(...args),
  };
  await assert.rejects(runAgents(parseAgentsArgs(["set", "a", "name=Edited"]), { store: racing, installed }), /changed on the host/);
  const after = (await real.list()).definitions[0].agent;
  assert.deepEqual([after.model, after.name], ["concurrent-model", "A"], "the concurrent change survived");
  const done = await runAgents(parseAgentsArgs(["set", "a", "name=Edited"]), { store: real, installed });
  assert.equal(done.code, 0, "control: with nothing in between the same set applies");
  assert.equal((await real.list()).definitions[0].agent.model, "concurrent-model", "and keeps the key it did not touch");
});

test("R6 A RECORD WHOSE BODY WAS NOT YET ARCHIVED: the next open archives it, and the outcome stays unknown", async () => {
  const dir = tempDir();
  await storeIn(dir).set("a", agent({ name: "Before" }), { installed: ALL });
  // An in-process stop runs the store's finally, which releases the lock (a SIGKILL does not; the
  // crash tests cover that). What matters here is the intent and temp it leaves behind.
  const dieAt = (point) => ({ boundary: (name) => { if (name === point) throw new Error(`stopped at ${point}`); } });
  // The set stops after writing its temp; then a recovery stops right after publishing its record.
  await assert.rejects(storeIn(dir, dieAt("temp-written")).set("a", agent({ name: "After" }), { installed: ALL }), /stopped/);
  const intent = readJson(path.join(dir, ".intent.json"));
  await assert.rejects(storeIn(dir, dieAt("recovered-record-written")).list(), /stopped/);
  assert.ok(fs.existsSync(path.join(dir, ".recovered", `${intent.operation}.json`)), "the record is published");
  assert.ok(fs.existsSync(path.join(dir, intent.tempName)), "the temp is still where the set left it");
  const listed = await storeIn(dir).list();
  assert.deepEqual(listed.recovered.map((r) => [r.arm, r.outcome]), [["record", "unknown"]]);
  assert.equal(readJson(path.join(dir, ".recovered", `${intent.operation}.body.json`)).agent.name, "After");
  assert.equal(fs.existsSync(path.join(dir, intent.tempName)), false);
});

test("R7 (26878fb) A LISTING THAT FAILS FOR ADOPTION OR FOR THE READ leaves the snapshot incomplete and records nothing", async () => {
  // One open lists the store directory twice: once to adopt, once to read. A valid hand edit is
  // pending, so adoption has work to do. Each case fails a chosen listing, by its number.
  const failListings = (dir, which) => {
    let listing = 0;
    return (target, options) => {
      if (path.resolve(target) === path.resolve(dir)) {
        listing += 1;
        if (which(listing)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return fs.readdirSync(target, options);
    };
  };
  const cases = [
    ["the adoption's listing only", (n) => n === 1],
    ["the read's listing only", (n) => n === 2],
    ["every listing", () => true],
    ["none (control)", () => false],
  ];
  for (const [name, which] of cases) {
    const dir = tempDir();
    await storeIn(dir).set("a", agent(), { installed: ALL });
    await storeIn(dir).snapshot({ installed: ALL });
    const body = readJson(path.join(dir, "a.json"));
    body.agent.name = "Edited by hand";
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(body));
    const digestBefore = ledgerOf(dir).snapshotDigest;
    const snap = await storeIn(dir, { readdirSync: failListings(dir, which) }).snapshot({ installed: ALL });
    const ledger = ledgerOf(dir);
    if (name.startsWith("none")) {
      assert.equal(snap.complete, true, name);
      assert.equal(ledger.ids.a.revision, 2, `${name}: the hand edit is adopted`);
      assert.notEqual(ledger.snapshotDigest, digestBefore, `${name}: and the new state recorded`);
    } else {
      assert.equal(snap.complete, false, name);
      assert.equal(snap.incomplete.enumerationFailed, "EACCES", name);
      assert.equal(ledger.snapshotDigest, digestBefore, `${name}: no digest is recorded from an unproven state`);
    }
  }
});

test("R7 A DIRECTORY THAT CANNOT BE LISTED makes the snapshot incomplete; not an error, not an empty set", async () => {
  const dir = tempDir();
  await storeIn(dir).set("a", agent(), { installed: ALL });
  const before = ledgerOf(dir);
  const refuseListing = (target, options) => {
    if (path.resolve(target) === path.resolve(dir)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.readdirSync(target, options);
  };
  const snap = await storeIn(dir, { readdirSync: refuseListing }).snapshot({ installed: ALL });
  assert.deepEqual([snap.complete, snap.incomplete?.enumerationFailed, snap.entries], [false, "EACCES", []]);
  assert.deepEqual(ledgerOf(dir), before, "nothing was adopted, removed or recorded");
});
