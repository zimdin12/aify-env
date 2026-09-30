#!/usr/bin/env node
// P0 C2: DefinitionStore is the only code that writes the definitions directory, DERIVED from the
// source rather than listed. Two rules over every module under lib/ and bin/:
//   1. only lib/agent-definitions.mjs names the directory (its folder name or its env override), so
//      nothing else can build a path into it except through the store;
//   2. a module that imports the store, or any of its pure companions, does not import `fs`: callers
//      hand the store their intent, they never touch its files themselves. The companions are pure.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = "lib/agent-definitions.mjs";

function modules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(mjs|js)$/.test(entry.name)) out.push({ file: rel, text: fs.readFileSync(path.join(ROOT, rel), "utf8") });
    }
  };
  walk("lib");
  walk("bin");
  return out;
}

//: The directory's own name as a string literal, or its override variable.
const NAMES_THE_DIRECTORY = /["'`]agent-definitions["'`/\\]|AIFY_AGENT_DEFINITIONS_DIR/;
const IMPORTS_FS = /from\s+["'](node:)?fs(\/promises)?["']|require\(\s*["'](node:)?fs["']\s*\)/;
const IMPORTS_THE_STORE_FAMILY = /from\s+["'][./]*(lib\/)?agent-definition(s|-schema|-snapshot|-recovery)\.mjs["']/;

/** Every violation of the two rules in a set of sources. */
function violations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (file !== STORE && NAMES_THE_DIRECTORY.test(text)) found.push(`${file} names the definitions directory`);
    const family = /^lib\/agent-definition-(schema|snapshot|recovery)\.mjs$/.test(file);
    if ((family || (file !== STORE && IMPORTS_THE_STORE_FAMILY.test(text))) && IMPORTS_FS.test(text)) {
      found.push(`${file} works with definitions and imports fs`);
    }
  }
  return found;
}

test("ONE WRITER: only the store names the directory, and its callers and companions import no fs", () => {
  const sources = modules();
  assert.ok(sources.length > 50, "the walk found the modules");
  const store = sources.find((s) => s.file === STORE);
  assert.ok(store && NAMES_THE_DIRECTORY.test(store.text) && IMPORTS_FS.test(store.text), "positive control: the store itself matches");
  const callers = sources.filter((s) => s.file !== STORE && IMPORTS_THE_STORE_FAMILY.test(s.text)).map((s) => s.file);
  assert.ok(callers.includes("bin/aify-env-agents.mjs") && callers.includes("lib/agent-definitions.mjs") === false, `the callers were found: ${callers}`);
  assert.deepEqual(violations(sources), []);
});

test("NEGATIVE CONTROL: the rules flag a module that reaches the directory itself", () => {
  const planted = [
    { file: "lib/sneaky.mjs", text: 'import fs from "node:fs";\nfs.writeFileSync(path.join(home, ".aify", "agent-definitions", "x.json"), "{}");' },
    { file: "bin/caller.mjs", text: 'import fs from "node:fs";\nimport { DefinitionStore } from "../lib/agent-definitions.mjs";' },
    { file: "lib/agent-definition-schema.mjs", text: 'import { readFileSync } from "fs";' },
    { file: "lib/env-reader.mjs", text: "const dir = process.env.AIFY_AGENT_DEFINITIONS_DIR;" },
  ];
  assert.equal(violations(planted).length, 4, violations(planted).join("; "));
});
