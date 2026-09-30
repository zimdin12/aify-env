#!/usr/bin/env node
// P0 C1 and C3 against the shared fixture, which aify-comms' validator runs too.
//
// The expected problems in cases.json are written by hand from the P0 rules, and its canonical bytes
// and digests are computed by Python's json.dumps and hashlib (make-cases.py), so neither is derived
// from the code under test.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  definitionDigest,
  definitionBytesProblems,
  definitionProblems,
  formatDefinitionFile,
  idProblems,
  isCounter,
  isOperationId,
  MAX_COUNTER,
  numberProblems,
  SCHEMA_VERSION,
  sha256Hex,
  UNAVAILABLE_HARNESS,
} from "../lib/agent-definition-schema.mjs";
import { snapshotBytes, snapshotDigest, snapshotEntry } from "../lib/agent-definition-snapshot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "agent-definitions", "cases.json"), "utf8"));

/** A case's file bytes: given exactly (`rawBase64`, `raw`), or the body as JSON.stringify writes it. */
const bytesOf = (c) => (c.rawBase64 !== undefined ? Buffer.from(c.rawBase64, "base64")
  : Buffer.from(c.raw !== undefined ? c.raw : JSON.stringify(c.body), "utf8"));

test("EVERY SHARED CASE gets exactly its expected problems, from the bytes the store reads", () => {
  assert.ok(FIXTURE.cases.length >= 80, "the fixture lost its cases");
  const count = (pred) => FIXTURE.cases.filter(pred).length;
  assert.ok(count((c) => c.problems.length === 0) > 10 && count((c) => c.problems.length > 0) > 40, "both valid and invalid cases");
  assert.ok(count((c) => c.population === "normalized") >= 8 && count((c) => c.raw !== undefined) >= 10, "both populations, and text cases");
  for (const c of FIXTURE.cases) {
    const { problems } = definitionBytesProblems(bytesOf(c), c.fileId, { population: c.population });
    assert.deepEqual(problems, c.problems, `${c.name} (${c.population})`);
    if (c.body !== undefined) {
      assert.deepEqual(definitionProblems(c.body, c.fileId, { population: c.population }), c.problems, `${c.name}: the parsed-body path agrees`);
    }
  }
});

test("ONE DESIRED BODY, TWO POPULATIONS: identity is ignored for adoption and required once normalized", () => {
  const pairs = FIXTURE.cases.filter((c) => /^identity (omitted|forged)/.test(c.name));
  assert.equal(pairs.length, 4);
  for (const c of pairs) assert.equal(c.problems.length === 0, c.population === "candidate", c.name);
});

test("THE GOLDEN AGENT VECTORS: the exact canonical bytes and sha-256 Python computed", () => {
  for (const v of FIXTURE.agentVectors) {
    assert.equal(canonicalJson(v.agent), v.canonical, v.name);
    assert.equal(definitionDigest(v.agent), v.sha256, v.name);
  }
});

test("THE GOLDEN SNAPSHOT VECTORS: entries and problems reordered, the largest safe counters", () => {
  for (const v of FIXTURE.snapshotVectors) {
    assert.equal(snapshotBytes(v.entries), v.canonical, v.name);
    assert.equal(snapshotDigest(v.entries), v.sha256, v.name);
  }
});

test("A SNAPSHOT DIGEST ignores the order it was enumerated in, and the definition body it carries", () => {
  const [, vector] = FIXTURE.snapshotVectors;
  const reversed = [...vector.entries].reverse().map((e) => ({ ...e, definition: { anything: true } }));
  assert.equal(snapshotDigest(reversed), vector.sha256);
});

test("COUNTERS are safe integers from 1, never rounded", () => {
  assert.equal(isCounter(1), true);
  assert.equal(isCounter(MAX_COUNTER), true);
  for (const bad of [0, -1, 1.5, MAX_COUNTER + 1, 2 ** 53, "1", null, Number.NaN]) assert.equal(isCounter(bad), false, String(bad));
  assert.throws(() => canonicalJson({ n: 2 ** 53 }), /integers only/);
  assert.throws(() => canonicalJson({ n: 0.5 }), /integers only/);
});

test("THE STORE'S FORMATTING is stable: formatting a formatted file changes nothing", () => {
  const body = { version: 1, revision: 2, agent: { env: { B: "1", A: "2" }, id: "x" }, incarnation: 1 };
  const once = formatDefinitionFile(body);
  assert.equal(formatDefinitionFile(JSON.parse(once)), once);
  assert.ok(once.indexOf('"agent"') < once.indexOf('"incarnation"'), "keys are sorted");
  assert.ok(once.indexOf('"A"') < once.indexOf('"B"'), "at every depth");
});

test("THE PIECES OTHER MODULES USE: the id rule alone, number tokens, digests, operation ids, the version", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(idProblems("coder-1"), []);
  assert.deepEqual(idProblems("agent\n"), ["id: pattern"]);
  assert.deepEqual(idProblems("com1.x", "agent.role"), ["agent.role: reserved-name"]);
  assert.deepEqual(idProblems(5), ["id: type"]);
  assert.deepEqual(numberProblems('{"a": 1, "b": "2.5", "c": -0}'), []);
  assert.deepEqual(numberProblems('{"a": 2.5, "b": 1e3, "c": 9007199254740992}').sort(), ["file: non-integer-number", "file: unsafe-integer"]);
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "the published sha-256 of nothing");
  assert.equal(isOperationId("0b6c2f4e-8d1a-4c3b-9e7f-1a2b3c4d5e6f"), true);
  for (const bad of ["0B6C2F4E-8D1A-4C3B-9E7F-1A2B3C4D5E6F", "../../x", "", 5, null]) assert.equal(isOperationId(bad), false, String(bad));
});

test("A SNAPSHOT ENTRY: valid and available, valid without its launcher, invalid", () => {
  const agent = { harness: "codex", name: "N" };
  const reading = { id: "a", problems: [], incarnation: 2, revision: 5, agent };
  const available = snapshotEntry(reading, new Set(["codex"]));
  assert.deepEqual({ ...available, definitionDigest: undefined }, { id: "a", state: "valid", incarnation: 2, revision: 5, definitionDigest: undefined, definition: agent, available: true });
  assert.equal(available.definitionDigest, definitionDigest(agent));
  assert.equal(snapshotEntry(reading, new Set(["claude"])).unavailableReason, UNAVAILABLE_HARNESS);
  assert.deepEqual(snapshotEntry({ id: "b", problems: ["z: x", "a: y"] }, new Set()), { id: "b", state: "invalid", problems: ["a: y", "z: x"] });
});
