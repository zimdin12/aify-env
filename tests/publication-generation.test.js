// The generation an instance publishes under (lib/publication-generation.mjs; 0.9 plan P0 C5).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { advanceGeneration, generationFile } from "../lib/publication-generation.mjs";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-generation-"));

test("EACH BOOT SAVES A HIGHER GENERATION than the last, whatever the clock does", () => {
  const home = scratch();
  const file = generationFile(home, "default");
  assert.equal(file, path.join(home, "env", "default.generation"));
  assert.equal(advanceGeneration(file, { nowMs: 5000 }), 5000, "no file: the clock");
  assert.equal(fs.readFileSync(file, "utf8"), "5000\n", "saved before it is returned");
  assert.equal(advanceGeneration(file, { nowMs: 5000 }), 5001, "two boots in one millisecond");
  assert.equal(advanceGeneration(file, { nowMs: 1000 }), 5002, "a clock that went backwards");
  assert.equal(advanceGeneration(file, { nowMs: 9000 }), 9000, "CONTROL: a clock ahead of the file is the clock");
  assert.equal(fs.readFileSync(file, "utf8"), "9000\n");
});

test("A DAMAGED FILE keeps its leading digits, never going lower than they say; with none it is lost", () => {
  const file = generationFile(scratch(), "default");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const garbage of ["", "abc", "-5"]) {
    fs.writeFileSync(file, garbage);
    assert.equal(advanceGeneration(file, { nowMs: 7000 }), 7000, `${JSON.stringify(garbage)}: lost, the clock recovers it`);
  }
  fs.writeFileSync(file, "9000\u0000garbage");
  assert.equal(advanceGeneration(file, { nowMs: 7000 }), 9001, "the digits are kept, so a clock behind them cannot reuse 9000");
  fs.writeFileSync(file, `${"0".repeat(16)}9000\u0000garbage`);
  assert.equal(advanceGeneration(file, { nowMs: 7000 }), 9001, "the whole run of digits, leading zeros and all (G2)");
});

test("NOTHING IS PUBLISHED UNDER A GENERATION THAT WAS NOT SAVED: a failed write, or an unreadable file, throws", () => {
  const file = generationFile(scratch(), "default");
  advanceGeneration(file, { nowMs: 5000 });
  const refused = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  assert.throws(() => advanceGeneration(file, { nowMs: 6000, write: () => { throw refused; } }), /disk full/);
  assert.equal(fs.readFileSync(file, "utf8"), "5000\n", "the saved generation is untouched");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => advanceGeneration(file, { nowMs: 6000, readFile: () => { throw denied; } }), /denied/,
    "a file that exists but cannot be read is not a lost one");
  assert.equal(advanceGeneration(file, { nowMs: 6000 }), 6000, "CONTROL: the next readable boot advances");
});

test("AN EXHAUSTED GENERATION THROWS BEFORE ANYTHING IS SAVED, and never restarts below what was used (G1)", () => {
  const file = generationFile(scratch(), "default");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${Number.MAX_SAFE_INTEGER - 1}\n`);
  assert.equal(advanceGeneration(file, { nowMs: 5000 }), Number.MAX_SAFE_INTEGER, "CONTROL: the last safe generation is still given");
  assert.throws(() => advanceGeneration(file, { nowMs: 5000 }), RangeError, "nothing is above it");
  assert.equal(fs.readFileSync(file, "utf8"), `${Number.MAX_SAFE_INTEGER}\n`, "the saved generation is untouched");
  for (const past of ["9007199254740993\n", "99999999999999999\n"]) {
    fs.writeFileSync(file, past);
    assert.throws(() => advanceGeneration(file, { nowMs: 5000 }), RangeError, `${past.trim()}: past the limit is exhausted, not lost`);
    assert.equal(fs.readFileSync(file, "utf8"), past, `${past.trim()}: left as it was`);
  }
  assert.throws(() => advanceGeneration(generationFile(scratch(), "x"), { nowMs: 2 ** 60 }), RangeError, "a clock past the limit");
});
