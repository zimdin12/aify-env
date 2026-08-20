#!/usr/bin/env node
// No product source file may reach 1000 lines.
//
// ADDED WHILE EVERY FILE IS SMALL, which is the only time this is free. The related project has a
// 20,545-line module in its history — written under a house rule that already said 1000 was a defect.
// The rule was recorded and nothing measured it, so it was violated for years by a file that doubled
// AFTER the rule was written down. A rule with no gate is a preference.
//
// NO ALLOWLIST, deliberately. The other repo's equivalent has one, empty, earned by paying five files
// off. Starting a new repo with an exemption list is starting with the debt, and an allowlist is where
// a gate stops being a gate: the first red turns into an append instead of a decision.
//
// 400 IS THE SIGNAL, 1000 IS THE DEFECT. This gate can only enforce the second — a test passes or it
// does not. The first is a judgement, so the summary prints the largest files on every run, where
// somebody will see a file drifting rather than discover it at 999.
//
// SCOPE: non-test JS/MJS only. Two exclusions, both deliberate and both stated rather than left to be
// inferred from a passing run:
//
//   TESTS are long on purpose. They carry the reasoning, and squeezing them trades explanation for a
//   number. A gate that swept them would make its first red a test file, and the cheapest fix would be
//   deleting the part that explains why.
//
//   SHELL is not covered. install.sh and render.sh are real source and this does not measure them,
//   which is the same call the related repo made about its own installer. Bringing shell in is a
//   reviewer decision, not a widening to do quietly, and saying so here means the gap is visible
//   rather than something a reader assumes was handled.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT = 1000;
const SIGNAL = 400;
const SOURCE_DIRS = ["lib", "bin", "scripts"];
const PRUNE = new Set(["node_modules", ".git", "tests", "fixtures"]);

function sourceFiles(dir, found = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (PRUNE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      found.push({
        path: path.relative(ROOT, full).split(path.sep).join("/"),
        lines: fs.readFileSync(full, "utf8").split("\n").length,
      });
    }
  }
  return found;
}

const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d)));

test("the scan finds source files at all", () => {
  // An empty scan reports "nothing oversized" and is indistinguishable from a healthy repo. This whole
  // family of checks is worthless without proof the instrument can see.
  assert.ok(files.length > 0, `no source files found under ${SOURCE_DIRS.join(", ")}`);
});

test("the scan EXCLUDES tests, which are long on purpose", () => {
  // If it swept tests too, the first red would be a test file and the fix would be deleting reasoning.
  assert.equal(files.some((f) => f.path.includes("tests/")), false);
});

test(`no source file reaches ${LIMIT} lines`, () => {
  const over = files.filter((f) => f.lines >= LIMIT);
  assert.deepEqual(
    over.map((f) => `${f.path} (${f.lines})`),
    [],
    "a file crossed the limit. Split it by responsibility rather than adding an exemption here — an "
    + "allowlist is where this stops being a gate.",
  );
});

test("REPORT: the largest files, so drift is visible before it is a defect", () => {
  // Not an assertion. 400 lines is a signal and a signal cannot be a pass/fail, so it is printed on
  // every run instead — somebody sees a file growing rather than discovering it at 999.
  const largest = [...files].sort((a, b) => b.lines - a.lines).slice(0, 5);
  const drifting = largest.filter((f) => f.lines >= SIGNAL);
  process.stdout.write(`# largest: ${largest.map((f) => `${f.path}=${f.lines}`).join(", ")}\n`);
  if (drifting.length) {
    process.stdout.write(`# past the ${SIGNAL}-line signal: ${drifting.map((f) => f.path).join(", ")}\n`);
  }
  assert.ok(largest.length > 0);
});
