#!/usr/bin/env node
// P0 C2: DefinitionStore is the only code that writes the definitions directory. A module can write
// into the directory only if it can name it, and there are exactly two ways to name it:
//
//   1. GET THE PATH FROM THE STORE. Ruled out at the source rather than by parsing imports: the gate
//      DERIVES, by calling them, which of the store module's exports hand the path back, and which
//      getters of a store instance do, and requires both to be none. With nothing to hand out, no
//      relay can pass the path on, whatever import grammar it uses (named, `export *`, `import * as`,
//      dynamic `import()`). Two relays that passed the previous, import-parsing gate are kept below
//      as specimens that now cannot reach a path.
//   2. BUILD THE PATH ITSELF, from the folder name or the override variable. Only the store may name
//      either in lib/ or bin/.
//
// And the store's pure companions import no `fs`. What a source gate cannot see: a module that spells
// the folder name some other way (split, encoded). That is a deliberate evasion, not an accidental
// second writer, and no source gate of this kind claims to catch it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as storeModule from "../lib/agent-definitions.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = "lib/agent-definitions.mjs";
const COMPANIONS = ["lib/agent-definition-schema.mjs", "lib/agent-definition-snapshot.mjs", "lib/agent-definition-recovery.mjs"];
const NAMES_THE_DIRECTORY = /["'`]agent-definitions["'`/\\]|AIFY_AGENT_DEFINITIONS_DIR/;
const IMPORTS_FS = /from\s+["'](node:)?fs(\/promises)?["']|require\(\s*["'](node:)?fs["']\s*\)/;

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

/**
 * Which exports of a module hand back a store directory, and which getters of a store built on it do.
 * Each export is called with an env naming a probe directory, and the store class is built on it.
 */
function pathLeaks(moduleNamespace) {
  const probe = path.join(os.tmpdir(), "aify-one-writer-probe-dir");
  const env = { AIFY_AGENT_DEFINITIONS_DIR: probe };
  const exports = Object.entries(moduleNamespace).filter(([, value]) => {
    if (typeof value !== "function") return value === probe;
    try { return value(env) === probe; } catch { return false; }
  }).map(([name]) => name);
  const getters = [];
  const Store = moduleNamespace.DefinitionStore;
  if (typeof Store === "function") {
    const instance = new Store({ dir: probe });
    const proto = Object.getPrototypeOf(instance);
    for (const key of Object.getOwnPropertyNames(proto)) {
      const getter = Object.getOwnPropertyDescriptor(proto, key)?.get;
      if (getter && getter.call(instance) === probe) getters.push(key);
    }
  }
  return { exports, getters };
}

/** Rules 2 and 3 over a set of sources. */
function sourceViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (file !== STORE && NAMES_THE_DIRECTORY.test(text)) found.push(`${file} names the definitions directory`);
    if (COMPANIONS.includes(file) && IMPORTS_FS.test(text)) found.push(`${file} is a pure companion and imports fs`);
  }
  return found;
}

test("ONE WRITER: the store hands its path to nothing, only the store names it, and the companions are pure", () => {
  assert.deepEqual(pathLeaks(storeModule), { exports: [], getters: [] });
  const sources = modules();
  assert.ok(sources.length > 50, "the walk found the modules");
  const store = sources.find((s) => s.file === STORE);
  assert.ok(NAMES_THE_DIRECTORY.test(store.text) && IMPORTS_FS.test(store.text), "positive control: the store itself names it and writes");
  assert.deepEqual(sourceViolations(sources), []);
});

test("NEGATIVE CONTROLS: a store that hands its path out is caught by derivation, and a module that names it by source", () => {
  const probe = path.join(os.tmpdir(), "aify-one-writer-probe-dir");
  class Leaky { constructor({ dir }) { this.d = dir; } get dir() { return this.d; } }
  const leakyModule = { definitionsDir: (env) => env.AIFY_AGENT_DEFINITIONS_DIR, DefinitionStore: Leaky, processAlive: () => false };
  assert.deepEqual(pathLeaks(leakyModule), { exports: ["definitionsDir"], getters: ["dir"] });
  assert.equal(new Leaky({ dir: probe }).dir, probe, "the planted getter really returns the path");
  const planted = [
    { file: "lib/literal.mjs", text: 'const dir = path.join(home, ".aify", "agent-definitions");' },
    { file: "lib/env-reader.mjs", text: "const dir = process.env.AIFY_AGENT_DEFINITIONS_DIR;" },
    { file: "lib/agent-definition-schema.mjs", text: 'import { readFileSync } from "fs";' },
    { file: "bin/honest-caller.mjs", text: 'import fs from "node:fs";\nimport { DefinitionStore } from "../lib/agent-definitions.mjs";' },
  ];
  assert.deepEqual(sourceViolations(planted).map((v) => v.split(" ")[0]), ["lib/literal.mjs", "lib/env-reader.mjs", "lib/agent-definition-schema.mjs"]);
});

test("THE RELAYS THAT PASSED THE OLD GATE now relay nothing: `export *` and a dynamic import of the store yield no path", async () => {
  // The review of 26878fb planted these two relays; both passed the import-parsing gate. Written here
  // as real modules and imported, each relays what the store exports, and none of that is the path.
  const storeUrl = new URL("../lib/agent-definitions.mjs", import.meta.url).href;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-relays-"));
  const relay = async (name, text) => {
    fs.writeFileSync(path.join(dir, name), text);
    return import(new URL(`file:///${path.join(dir, name).replace(/\\/g, "/")}`).href);
  };
  const wildcardRelay = await relay("wildcard.mjs", `export * from ${JSON.stringify(storeUrl)};\n`);
  const dynamicRelay = await relay("dynamic.mjs",
    `const { definitionsDir } = await import(${JSON.stringify(storeUrl)});\nexport { definitionsDir };\nexport const DefinitionStore = (await import(${JSON.stringify(storeUrl)})).DefinitionStore;\n`);
  assert.equal(typeof wildcardRelay.DefinitionStore, "function", "the wildcard relay does relay the store's exports");
  for (const [name, relayed] of [["export * from", wildcardRelay], ["await import()", dynamicRelay]]) {
    assert.deepEqual(pathLeaks(relayed), { exports: [], getters: [] }, name);
  }
  assert.equal(dynamicRelay.definitionsDir, undefined, "the dynamic relay's definitionsDir is undefined: there is none to take");
  assert.equal("definitionsDir" in wildcardRelay, false, "the wildcard relay has no definitionsDir: there is none to take");
});
