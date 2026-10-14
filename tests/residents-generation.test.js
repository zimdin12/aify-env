// The residents generation (B1 contract item 5; reviewer gate 3): a fresh home may initialise, anything else that is
// missing, unreadable or invalid is no role, and a valid file advances by exactly one. Real files in a temp home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseGenerationText, residentsStateEvidence, takeResidentsGeneration } from "../lib/residents-generation.mjs";

const LIFETIME = "7f3c9e2a-0000-4000-8000-0000000000b1";
const NOW = 1_790_000_000_000;
function home(t) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-res-gen-")), ".aify");
  fs.mkdirSync(path.join(dir, "env"), { recursive: true });
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}
const generationFile = (dir) => path.join(dir, "env", "residents.generation");
const record = (dir, instance, agentId = "lead") => {
  fs.mkdirSync(path.join(dir, "residents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "residents", `${agentId}.${LIFETIME}.json`), JSON.stringify({ agentId, lifetime: LIFETIME,
    instance, harness: "claude", pid: 41, launcher: "C:/x/claude-aify", writtenAtUs: 1_790_000_000_000_000 }));
};

test("the generation text is strict: digits, one optional newline, no leading zero, a successor", () => {
  for (const [text, ok] of [["7\n", true], ["7", true], ["7\r\n", true], ["9007199254740990\n", true],
    ["0\n", false], ["07\n", false], ["7 \n", false], [" 7", false], ["7\n\n", false], ["-7", false], ["7.5", false],
    ["", false], ["seven", false], ["9007199254740991", false], ["99999999999999999999", false]]) {
    assert.equal(parseGenerationText(text).ok, ok, JSON.stringify(text));
  }
  assert.deepEqual(parseGenerationText("41\n"), { ok: true, last: 41 });
});

test("a valid file advances by exactly one and is saved before it is returned; successive takes strictly increase", (t) => {
  const dir = home(t);
  fs.writeFileSync(generationFile(dir), "41\n");
  assert.deepEqual(takeResidentsGeneration(dir, { nowMs: NOW }), { ok: true, generation: 42 }, "plus one, not the clock");
  assert.equal(fs.readFileSync(generationFile(dir), "utf8"), "42\n");
  assert.deepEqual(takeResidentsGeneration(dir, { nowMs: 1 }), { ok: true, generation: 43 }, "a clock behind changes nothing");
});

test("a genuinely fresh home initialises from the clock; a default-stamped record does not make it unfresh", (t) => {
  const dir = home(t);
  record(dir, "default", "legacy");
  assert.deepEqual(residentsStateEvidence(dir), []);
  assert.deepEqual(takeResidentsGeneration(dir, { nowMs: NOW }), { ok: true, generation: NOW });
  assert.equal(fs.readFileSync(generationFile(dir), "utf8"), `${NOW}\n`);
});

for (const [name, seed, evidence] of [
  ["a residents descriptor", (dir) => fs.writeFileSync(path.join(dir, "env", "residents.json"), "{}"), /residents\.json/],
  ["a residents turns journal", (dir) => fs.writeFileSync(path.join(dir, "env", "residents.turns.json"), "{}"), /residents\.turns\.json/],
  ["a residents record", (dir) => record(dir, "residents"), /a residents record/],
  ["a record that cannot be parsed", (dir) => { record(dir, "residents"); fs.writeFileSync(path.join(dir, "residents", `lead.${LIFETIME}.json`), "{"); }, /not JSON/],
]) {
  test(`a missing generation beside ${name} is uncertain: no role, nothing written`, (t) => {
    const dir = home(t);
    seed(dir);
    const taken = takeResidentsGeneration(dir, { nowMs: NOW });
    assert.equal(taken.ok, false);
    assert.match(taken.reason, /^generation-missing-with-residents-state: /);
    assert.match(taken.reason, evidence);
    assert.equal(fs.existsSync(generationFile(dir)), false, "an uncertain generation was guessed and saved");
  });
}

for (const [name, seed, reason] of [
  ["unreadable (a directory)", (file) => fs.mkdirSync(file), /^generation-unreadable: /],
  ["malformed", (file) => fs.writeFileSync(file, "12x\n"), /^generation-invalid$/],
  ["zero", (file) => fs.writeFileSync(file, "0\n"), /^generation-invalid$/],
  ["exhausted", (file) => fs.writeFileSync(file, `${Number.MAX_SAFE_INTEGER}\n`), /^generation-exhausted$/],
]) {
  test(`an ${name} generation file is no role and is left as it was`, (t) => {
    const dir = home(t);
    const file = generationFile(dir);
    seed(file);
    const before = fs.statSync(file).isDirectory() ? "dir" : fs.readFileSync(file, "utf8");
    const taken = takeResidentsGeneration(dir, { nowMs: NOW });
    assert.equal(taken.ok, false);
    assert.match(taken.reason, reason);
    assert.equal(fs.statSync(file).isDirectory() ? "dir" : fs.readFileSync(file, "utf8"), before);
  });
}

test("a guard that refuses at the save leaves the file as it was and gives no generation", (t) => {
  const dir = home(t);
  fs.writeFileSync(generationFile(dir), "41\n");
  const taken = takeResidentsGeneration(dir, { nowMs: NOW, guard: () => { throw Object.assign(new Error("moved"), { code: "NOT_OWNER" }); } });
  assert.deepEqual(taken, { ok: false, reason: "generation-unwritable: NOT_OWNER" });
  assert.equal(fs.readFileSync(generationFile(dir), "utf8"), "41\n");
});
