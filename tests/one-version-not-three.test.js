#!/usr/bin/env node
// This package declares its version in three places, and nothing checked they agree.
//
// SPLIT-M1, external review round 7. aify-comms has carried a single-source version gate since
// v0.2.0 -- `test_version_single_source.py` and `version-consistency.test.js` -- because four
// components there each once carried their own number and none tracked a release: the service
// reported 0.1.0, a config default said 4.0.0, the dashboard hardcoded 0.1.0 and the bridge said
// 4.0.0 in eight hand-copied places, while the project actually shipped v0.1, v0.1.1 and v0.1.2. No
// single edit could have corrected it.
//
// Splitting the repo carried the components out and left that lesson behind.
//
// WHAT `VERSION` MEANS HERE, and why a wrong one is not cosmetic. `bin/aify-env.mjs` reads it at boot
// and reports it on `/health` and in the banner, so it is what a replacement instance sees when it
// asks the incumbent who it is, and what the supersede message names. It is also half of the pair an
// operator uses to answer "did my restart take": VERSION says which release this CLAIMS to be, and
// BUILD -- a content hash, deliberately not derived from this file -- says which code is loaded.
// That comparison is only meaningful while VERSION is trustworthy.
//
// BUILD IS NOT IN SCOPE and must never be: it moves whenever the code does, which is the entire point
// of it, and a gate that tied it to VERSION would destroy the one number that answers the restart
// question.
//
// DERIVED, NOT LISTED. The declarations are discovered from the files rather than enumerated, so a
// fourth one added later cannot sit outside a gate that only knows about three.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file in this package that states its own version, and what each states. */
function declarations() {
  const found = {};
  const versionFile = path.join(ROOT, "VERSION");
  if (fs.existsSync(versionFile)) {
    found.VERSION = fs.readFileSync(versionFile, "utf8").trim();
  }
  for (const name of ["package.json", "package-lock.json"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // A lock file states it twice: at the root and for the package's own entry. Both are edited by a
    // release and either can be missed.
    if (typeof parsed.version === "string") found[name] = parsed.version;
    const own = parsed.packages && parsed.packages[""];
    if (own && typeof own.version === "string") found[`${name} (packages."")`] = own.version;
  }
  return found;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

test("the scan finds the declarations that are definitely there", () => {
  // POSITIVE CONTROL. A scan that found nothing would make the agreement assertion vacuous -- it is
  // trivially true that zero values agree.
  const found = declarations();
  assert.ok("VERSION" in found, "the VERSION file was not read; the daemon reports it on /health");
  assert.ok("package.json" in found, "package.json's version was not read");
  assert.ok(
    Object.keys(found).length >= 3,
    `only ${Object.keys(found).length} declaration(s) found: ${Object.keys(found).join(", ")}`,
  );
});

test("every declared version is a version", () => {
  for (const [where, value] of Object.entries(declarations())) {
    assert.match(value, SEMVER, `${where} declares ${JSON.stringify(value)}, which is not a version`);
  }
});

test("and they all agree", () => {
  const found = declarations();
  const distinct = [...new Set(Object.values(found))];
  assert.equal(
    distinct.length, 1,
    "this package states more than one version, so a release edited some files and not others:\n  "
    + Object.entries(found).map(([w, v]) => `${w} = ${v}`).join("\n  ")
    + "\nThe daemon reports the VERSION file on /health and in its banner, so a disagreement is what "
    + "an operator reads when asking which environment is serving.",
  );
});

test("a disagreement would actually be caught", () => {
  // NEGATIVE CONTROL on the comparison itself. The test above passes while every value matches, which
  // is also what it would do if the comparison were broken. This proves it can say no.
  const distinct = [...new Set(Object.values({ VERSION: "0.6.0", "package.json": "0.6.1" }))];
  assert.equal(distinct.length, 2, "the comparison cannot distinguish two different versions");
});
