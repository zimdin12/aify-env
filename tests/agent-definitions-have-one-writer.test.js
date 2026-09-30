#!/usr/bin/env node
// P0 C2: DefinitionStore is the only code that writes the definitions directory, DERIVED rather than
// listed. A module can write into the directory only if it can name it, so the gate finds every way
// to name it and requires that only the store holds one:
//
//   1. THE PATH SOURCES are derived from the store module's behaviour, not written down: every export
//      that, called or constructed, hands back the directory's path. Today that is `definitionsDir`;
//      the store instance exposes none (it has no path getter), and the gate checks that too.
//   2. No other module under lib/ or bin/ names the directory (its folder name or env override), or
//      imports a path source -- by name, through a re-export, or through `import * as`. A helper that
//      re-exports a path source is itself a path source, so the check is TRANSITIVE over imports.
//   3. The store's pure companions import no `fs`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../lib/agent-definitions.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = "lib/agent-definitions.mjs";
const COMPANIONS = ["lib/agent-definition-schema.mjs", "lib/agent-definition-snapshot.mjs", "lib/agent-definition-recovery.mjs"];

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

/** Which of the store's exports hand back the directory: called with an env naming a probe dir. */
function derivePathSources() {
  const probe = path.join(os.tmpdir(), "aify-one-writer-probe-dir");
  const sources = [];
  for (const [name, value] of Object.entries(store)) {
    if (typeof value !== "function") continue;
    let result;
    try { result = value({ AIFY_AGENT_DEFINITIONS_DIR: probe }); } catch { continue; }
    if (result === probe) sources.push(name);
  }
  // The instance: no own or prototype member may hand the directory back.
  const instance = new store.DefinitionStore({ dir: probe });
  const proto = Object.getPrototypeOf(instance);
  const leaks = Object.getOwnPropertyNames(proto).filter((key) => {
    const getter = Object.getOwnPropertyDescriptor(proto, key)?.get;
    return getter !== undefined && getter.call(instance) === probe;
  });
  return { sources, leaks };
}

const NAMES_THE_DIRECTORY = /["'`]agent-definitions["'`/\\]|AIFY_AGENT_DEFINITIONS_DIR/;
const IMPORTS_FS = /from\s+["'](node:)?fs(\/promises)?["']|require\(\s*["'](node:)?fs["']\s*\)/;

/** Module specifiers a source imports or re-exports from, resolved to repo-relative files. */
function importsOf({ file, text }) {
  const out = [];
  for (const m of text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (!m[1].startsWith(".")) continue;
    out.push({ target: path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])), clause: m[0] });
  }
  return out;
}

/** Every violation of rules 2 and 3 over a set of sources, given the path sources. */
function violations(sources, pathSources) {
  const found = [];
  const byFile = new Map(sources.map((s) => [s.file, s]));
  // A module "holds a path source" if it imports one from the store (by name or namespace), or
  // imports anything a holder exports. Iterated to a fixed point: holding is transitive.
  const holders = new Set([STORE]);
  const takesASource = (clause) => /\*\s+as\s+/.test(clause) || pathSources.some((name) => new RegExp(`\\b${name}\\b`).test(clause));
  for (let changed = true; changed;) {
    changed = false;
    for (const source of sources) {
      if (holders.has(source.file)) continue;
      const holds = importsOf(source).some(({ target, clause }) => holders.has(target) && (target !== STORE || takesASource(clause)));
      if (holds) { holders.add(source.file); changed = true; }
    }
  }
  for (const holder of holders) if (holder !== STORE && byFile.has(holder)) found.push(`${holder} can name the definitions directory`);
  for (const { file, text } of sources) {
    if (file !== STORE && NAMES_THE_DIRECTORY.test(text)) found.push(`${file} names the definitions directory`);
    if (COMPANIONS.includes(file) && IMPORTS_FS.test(text)) found.push(`${file} is a pure companion and imports fs`);
  }
  return [...new Set(found)];
}

test("ONE WRITER: the path sources are derived, only the store holds one, and the companions are pure", () => {
  const { sources: pathSources, leaks } = derivePathSources();
  assert.deepEqual(pathSources, ["definitionsDir"], "the store's exports that hand back its directory");
  assert.deepEqual(leaks, [], "a store instance hands back no path");
  const sources = modules();
  assert.ok(sources.length > 50, "the walk found the modules");
  const storeSource = sources.find((s) => s.file === STORE);
  assert.ok(NAMES_THE_DIRECTORY.test(storeSource.text) && IMPORTS_FS.test(storeSource.text), "positive control: the store itself matches");
  assert.ok(importsOf(sources.find((s) => s.file === "bin/aify-env-agents.mjs")).some((i) => i.target === STORE), "the CLI's import of the store is seen");
  assert.deepEqual(violations(sources, pathSources), []);
});

test("NEGATIVE CONTROLS: every way to reach the directory is flagged, a caller that only uses the store is not", () => {
  const sources = [
    { file: STORE, text: 'import fs from "node:fs";\nexport function definitionsDir() {}' },
    { file: "lib/relay.mjs", text: 'export { definitionsDir } from "./agent-definitions.mjs";' },
    { file: "lib/second-writer.mjs", text: 'import fs from "node:fs";\nimport { definitionsDir } from "./relay.mjs";\nfs.writeFileSync(path.join(definitionsDir(env), "second.json"), "{}");' },
    { file: "lib/namespace.mjs", text: 'import * as defs from "./agent-definitions.mjs";' },
    { file: "lib/literal.mjs", text: 'const dir = path.join(home, ".aify", "agent-definitions");' },
    { file: "lib/env-reader.mjs", text: "const dir = process.env.AIFY_AGENT_DEFINITIONS_DIR;" },
    { file: "lib/agent-definition-schema.mjs", text: 'import { readFileSync } from "fs";' },
    { file: "bin/honest-caller.mjs", text: 'import fs from "node:fs";\nimport { DefinitionStore } from "../lib/agent-definitions.mjs";' },
  ];
  const found = violations(sources, ["definitionsDir"]);
  for (const file of ["lib/relay.mjs", "lib/second-writer.mjs", "lib/namespace.mjs", "lib/literal.mjs", "lib/env-reader.mjs", "lib/agent-definition-schema.mjs"]) {
    assert.ok(found.some((v) => v.startsWith(file)), `${file} was not flagged: ${found.join("; ")}`);
  }
  assert.equal(found.some((v) => v.startsWith("bin/honest-caller.mjs")), false, "using the store is not reaching the directory");
});
