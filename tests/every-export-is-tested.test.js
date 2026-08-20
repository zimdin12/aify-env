#!/usr/bin/env node
// Every export of every lib module must be named by some test.
//
// PORTED BECAUSE IT PAID FOR ITSELF ELSEWHERE. aify-comms has this gate, and within one run it caught
// an export added in this same work — with no test AND no caller — that a hand audit had just missed
// while looking for exactly that. A check that runs every time beats a habit of checking.
//
// It is the finer floor. "Does this module have a test file" catches a module extracted in a hurry; it
// cannot see a module whose test exercises two of its nine exports, where the other seven are as
// untested as if there were no test at all — and are invisible, because the module reads as covered.
//
// WHAT IT PROVES AND WHAT IT DOES NOT. "A test names it" is not "a test asserts anything useful about
// it": a mention in a comment counts. Deliberately generous, because the case worth catching is the
// export nothing anywhere mentions.
//
// THE EXTRACTOR HAS A POSITIVE CONTROL, and that is not decoration. A regex that silently stopped
// matching would report zero untested exports forever, which is the same green as a healthy repo. So
// one test requires it to find a known set from a known file: if it can no longer see what is
// unmistakably there, this gate fails rather than passing quietly.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");
const TESTS = path.join(ROOT, "tests");

/**
 * Exported names from a module's source.
 *
 * Only the forms this repo actually uses — `export function`, `export class`, `export const|let`. A
 * form that appears later and is not matched here would be silently uncovered, which is what the
 * positive control below is for.
 */
function exportedNames(source) {
  const names = new Set();
  const pattern = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

const libFiles = fs.readdirSync(LIB).filter((n) => n.endsWith(".mjs"));
const testSource = fs.readdirSync(TESTS)
  .filter((n) => n.endsWith(".js") || n.endsWith(".mjs"))
  .map((n) => fs.readFileSync(path.join(TESTS, n), "utf8"))
  .join("\n");

test("the scan sees modules and exports — neither side is empty", () => {
  // Without this, an empty scan reports "nothing untested" and looks identical to a clean repo. The
  // instrument has to prove it can see before its zero means anything.
  assert.ok(libFiles.length > 0, `no modules found in ${LIB}`);
  const total = libFiles.reduce(
    (n, f) => n + exportedNames(fs.readFileSync(path.join(LIB, f), "utf8")).length,
    0,
  );
  assert.ok(total > 0, "no exports found at all; the extractor is broken");
  assert.ok(testSource.length > 0, "no test sources were read");
});

test("POSITIVE CONTROL: the extractor finds what is unmistakably in allowlist.mjs", () => {
  // A regex that stopped matching would report zero untested exports forever — the same green as a
  // healthy repo. This is the negative control's twin: prove it can find before trusting it to say no.
  const names = exportedNames(fs.readFileSync(path.join(LIB, "allowlist.mjs"), "utf8"));
  for (const expected of ["mayExecute", "markerOf"]) {
    assert.ok(names.includes(expected), `the extractor missed ${expected}; it can no longer see`);
  }
});

test("NEGATIVE CONTROL: the extractor does not invent exports", () => {
  // And it must be able to say none, or "found everything" is meaningless.
  assert.deepEqual(exportedNames("const notExported = 1;\nfunction alsoNot() {}\n"), []);
});

test("no export is named by no test", () => {
  const orphans = [];
  for (const file of libFiles) {
    const source = fs.readFileSync(path.join(LIB, file), "utf8");
    for (const name of exportedNames(source)) {
      // Generous on purpose: a whole-word mention anywhere in any test file counts.
      if (!new RegExp(`\\b${name}\\b`).test(testSource)) orphans.push(`lib/${file}#${name}`);
    }
  }
  assert.deepEqual(
    orphans,
    [],
    "these exports are named by no test:\n  " + orphans.join("\n  ")
    + "\n\nAn export is the unit another module depends on. If one genuinely cannot be tested, say so in "
    + "its module's test file and test what can be reached — do not add an exemption list here, because "
    + "a list is where this stops being a gate.",
  );
});
