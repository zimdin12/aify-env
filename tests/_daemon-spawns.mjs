// The daemon spawns in this test directory, and whether each one's env passes through a seal: shared by the gates
// that keep a test daemon away from the operator's registry (no-test-daemon-inherits-the-real-registry.test.js) and
// away from the operator's home (no-test-daemon-resolves-the-real-home.test.js). Moved here unchanged from the first,
// so both gates judge one population with one instrument. `sealsDirectly` is each gate's own seal.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Test files, excluding the shared helpers that define the seal itself. */
export function testFiles() {
  return readdirSync(HERE)
    .filter((name) => /\.(test\.)?m?js$/.test(name) && !name.startsWith("_"))
    .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }));
}

/**
 * Every spawn whose argv mentions the daemon entry point.
 *
 * THE POPULATION WAS HALF THE POPULATION (R9-M8, external review 2026-09-06). This matched `spawn(`
 * only, and only argv naming `DAEMON` or `aify-env.mjs` -- so `spawnSync(` was invisible, and so was
 * every file that names the entry point through a local `ENTRY` constant. Measured on the day it was
 * widened: the gate saw 9 daemon spawns and could not see 10 more, across 7 files.
 *
 * Nothing was leaking -- each of the ten was sealed, checked by hand. That is the point worth
 * stating: a gate whose population is narrower than its claim reads exactly like a gate that is
 * working, and this repo has been caught by that shape before.
 */
export function daemonSpawns(text) {
  const out = [];
  let at = 0;
  for (;;) {
    // `spawnSync` IS A SPAWN. Searching for the bare word finds both, and the brace walk below
    // starts from the paren rather than a fixed offset so the two lengths cannot drift.
    const match = /\bspawn(?:Sync)?\s*\(/.exec(text.slice(at));
    if (!match) return out;
    const found = at + match.index;
    // The call's arguments, to its matching paren -- crude but sufficient: these are hand-written
    // test files, not generated code.
    let depth = 0;
    let end = found;
    for (let i = found + match[0].length - 1; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const call = text.slice(found, end + 1);
    at = end + 1;
    // A SPAWN INSIDE A STRING IS NOT A SPAWN. `no-test-binds-a-hardcoded-port.test.js` carries
    // `'  spawn(node, [ENTRY, "--port", "8894"]);'` as its own positive control, and the widened
    // scan reported it as an unsealed daemon launch. Accusing another gate's fixture is how a gate
    // loses its readers.
    if (insideStringLiteral(text, found)) continue;
    // `ENTRY` is how seven files name the same file. A gate that only knows one of the names is a
    // gate that only governs one of the files.
    if (/DAEMON|ENTRY|aify-env\.mjs/.test(call)) out.push(call);
  }
}

/**
 * Is `index` inside a quoted string on its own line?
 *
 * Counts unescaped quotes from the start of the line. An odd count of any quote character means the
 * position is inside a literal. Line-scoped and deliberately simple: these are hand-written test
 * files, and the alternative is a parser for a question that only needs to separate real code from a
 * quoted example.
 */
function insideStringLiteral(text, index) {
  const lineStart = text.lastIndexOf(String.fromCharCode(10), index) + 1;
  const before = text.slice(lineStart, index);
  for (const quote of ['"', "'", "`"]) {
    let count = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] === String.fromCharCode(92)) { i += 1; continue; }
      if (before[i] === quote) count += 1;
    }
    if (count % 2 === 1) return true;
  }
  return false;
}

/**
 * Is this daemon spawn sealed, following the env expression ONE level into the file?
 *
 * WHY INDIRECTION HAD TO BE HANDLED (R9-M8). Widening the population to `spawnSync` and to files that
 * name the entry point through an `ENTRY` constant took the gate from 9 spawns to 19 -- and nine of
 * the new ones seal through a name: `{ env }`, `env: sealedEnv(record, port)`, `...SEALED`. Reading
 * only the call text, every one of them looks unsealed. Hand-checking showed all nine are fine, so a
 * gate that flagged them would be nine false alarms on its first run and would be switched off.
 *
 * ONE LEVEL, NOT A RESOLVER. Each identifier in the env position is looked up as a `const` or
 * `function` in the same file and that definition is tested. Deeper chains are not followed, and a
 * name this cannot resolve is reported rather than assumed sealed -- an unresolvable name is exactly
 * the case where nobody can say.
 */
export function sealedThrough(call, fileText, sealsDirectly, { fileFallback = true } = {}) {
  if (sealsDirectly(call)) return true;

  // A SPAWN THAT PASSES NO ENV AT ALL IS THE DANGEROUS ONE, and it is the only shape this gate can
  // judge with certainty. The leak happens by OMISSION: a child with no `env` inherits this process's,
  // finds `~/.aify/services.json`, and claims a spawn on the operator's live fleet. Nothing about the
  // rest of the file can make that safe.
  if (!/\benv\s*[:,}]/.test(call)) return false;

  const envAt = call.search(/\benv\s*[:,}]/);
  const region = envAt === -1 ? call : call.slice(envAt);
  // `env` ITSELF IS A NAME. `{ env, stdio: ... }` is shorthand for `env: env`, so excluding it left
  // the four files that build a sealed `const env` earlier looking unsealed. `box.env` resolves the
  // same way, through the root identifier.
  const names = new Set(region.match(/[A-Za-z_$][\w$]*/g) || []);
  for (const name of names) {
    const def = new RegExp(`(?:const|let|var|function)\\s+${name}\\b[\\s\\S]{0,600}`).exec(fileText);
    if (def && sealsDirectly(def[0])) return true;
  }

  // WHERE THIS GATE STOPS, said plainly rather than left to be discovered. Four files pass the env as
  // a FUNCTION PARAMETER built by a factory (`sealed(label).env(record)`), so no definition of the
  // name `env` exists to resolve -- one level of lookup cannot reach a value that is constructed at
  // the call site of an enclosing helper, and chasing it would mean writing a resolver.
  //
  // So for a call that DOES pass an env, the gate falls back to asking whether the file seals
  // anywhere. That is weaker: a file with one sealed spawn and one that passes a different,
  // unsealed env would pass. It is still strictly more than the old gate, which could not see these
  // files at all. What it now guarantees is the omission case above, which is the one that leaks.
  // A GATE MAY REFUSE THE FALLBACK (`fileFallback: false`) and name each such spawn instead.
  return fileFallback && sealsDirectly(fileText);
}
