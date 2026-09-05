// No test may spawn a daemon that can find the operator's fleet.
//
// THE LEAK THIS CLOSES, root-caused 2026-09-03 after the hunt for it was capped. `doctor-live.test.js`
// sealed the daemon's PROCESS RECORD -- so it could not reap processes it never started -- and then
// spread `process.env` for everything else. The registry was everything else. So the spawned daemon
// resolved the real `~/.aify/services.json`, found the live aify-comms, loaded its plugin, and
// claimed a spawn out from under the operator.
//
// EVERY SYMPTOM THE HUNT RECORDED FOLLOWS FROM THAT. Transient, because the test daemon is killed
// seconds later and the service self-heals in about two minutes. Invisible to bisect, because it is
// a race between the claim pass firing and `stopDaemon`. Only ever on a FULL suite run, because that
// is the only time this file runs. Three leaks had already been fixed by hand; this is the fourth,
// and a hand-fix would leave the fifth to somebody else.
//
// SO THE RULE IS ENFORCED, NOT REMEMBERED. `sealedDaemonEnv` exists and says why in its own header;
// what was missing was anything noticing a spawn that did not use it.
//
// IT READS SOURCE, and that is a weaker instrument than running the thing -- it can be fooled by a
// spawn assembled at runtime. It is still the right one here: the alternative is starting daemons to
// find out, and starting shared infrastructure to test it has cost this project a live fleet twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Test files, excluding the shared helpers that define the seal itself. */
function testFiles() {
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
function daemonSpawns(text) {
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

/** Text that seals the registry: the shared helper, or an explicit non-empty path. */
function sealsDirectly(text) {
  // AN EMPTY SEAL IS NOT A SEAL. `AIFY_SERVICE_REGISTRY: ""` satisfied the old check for the mere
  // presence of the name, and the helper's own header records why that is the trap:
  // `process.env.X || fallback` reads "" as unset and resolves straight back to the operator's file.
  return /sealedDaemonEnv/.test(text)
    || /AIFY_SERVICE_REGISTRY\s*:\s*(?!["'`]\s*["'`])\S/.test(text);
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
function isSealed(call, fileText) {
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
  return sealsDirectly(fileText);
}

test("THE SCAN FINDS A DAEMON SPAWN AT ALL", () => {
  // POSITIVE CONTROL. The assertion below is "none of them is unsealed", which an empty list
  // satisfies perfectly -- and an empty list is exactly what a broken scan returns.
  const total = testFiles().reduce((n, f) => n + daemonSpawns(f.text).length, 0);
  assert.ok(total > 0, "no daemon spawn found in any test file; the scan is not reaching them");
});

test("EVERY TEST-SPAWNED DAEMON IS SEALED AGAINST THE OPERATOR'S REGISTRY", () => {
  // A spawn that spreads `process.env` inherits `~/.aify/services.json` by omission -- there is no
  // error, no warning, and the only symptom is somebody else's fleet moving.
  const offenders = [];
  for (const { name, text } of testFiles()) {
    for (const call of daemonSpawns(text)) {
      const sealed = isSealed(call, text);
      if (!sealed) offenders.push(`${name}: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "a test spawns the daemon without sealing the service registry. It will find the operator's live "
    + "aify-comms through ~/.aify/services.json and claim a spawn. Use `sealedDaemonEnv(...)` from "
    + "tests/_sealed-daemon-env.mjs, which seals the registry, advertising and the dashboard together.");
});

test("the seal names a path that cannot exist, rather than an empty one", () => {
  // The trap the helper's own header records: `process.env.X || fallback` reads "" as unset, so
  // sealing with an empty string resolves straight back to the operator's file. Asserted here as
  // well as there, because this gate is what a future author will read when it fires.
  const helper = readFileSync(join(HERE, "_sealed-daemon-env.mjs"), "utf8");
  assert.match(helper, /AIFY_SERVICE_REGISTRY: process\.env\.AIFY_SERVICE_REGISTRY \|\| NO_REGISTRY/);
  assert.match(helper, /NO_REGISTRY = "\/aify-tests\/no-such-registry\.json"/);
});

test("THE WIDENED SCAN REACHES spawnSync AND ENTRY-NAMED SPAWNS", () => {
  // R9-M8, external review 2026-09-06. The scan matched `spawn(` only, and only argv naming `DAEMON`
  // or `aify-env.mjs`. Measured the day it was widened: it saw 9 daemon spawns and could not see 10
  // more, across 7 files -- more than half the population, invisible. Nothing was leaking, and that
  // is the point: a gate whose population is narrower than its claim reads exactly like one that is
  // working.
  const found = daemonSpawns([
    'spawnSync(process.execPath, [DAEMON, "--port", "0"], { env: {} });',
    'spawn(process.execPath, [ENTRY, "--port", "0"], { env: {} });',
  ].join(String.fromCharCode(10)));
  assert.equal(found.length, 2, "the scan still cannot see spawnSync or an ENTRY-named spawn");
});

test("A SPAWN THAT PASSES NO ENV IS ALWAYS AN OFFENDER", () => {
  // The omission case, which is the one that actually leaks: no `env` means the child inherits this
  // process's, finds ~/.aify/services.json and claims a spawn on the operator's live fleet. No amount
  // of sealing elsewhere in the file makes that call safe, so the file-level fallback must not rescue
  // it.
  const sealedFile = 'const env = sealedDaemonEnv({});' + String.fromCharCode(10)
    + 'spawn(process.execPath, [ENTRY, "--port", "0"]);';
  const [call] = daemonSpawns(sealedFile);
  assert.ok(call, "the scan did not find the spawn, so this proves nothing");
  assert.equal(isSealed(call, sealedFile), false,
    "a daemon spawn with no env was treated as sealed because the FILE seals somewhere else");
});

test("AN EMPTY REGISTRY PATH IS NOT A SEAL", () => {
  // The helper's own header records the trap: `process.env.X || fallback` reads "" as unset and
  // resolves straight back to the operator's file. The old check tested for the NAME's presence.
  assert.equal(sealsDirectly('{ AIFY_SERVICE_REGISTRY: "" }'), false);
  assert.equal(sealsDirectly("{ AIFY_SERVICE_REGISTRY: '' }"), false);
  assert.equal(sealsDirectly('{ AIFY_SERVICE_REGISTRY: "/nope.json" }'), true);
});

test("a spawn quoted inside another gate's fixture is not accused", () => {
  // `no-test-binds-a-hardcoded-port.test.js` carries a spawn call as a STRING, in its own positive
  // control. The widened scan reported it as an unsealed daemon launch on its first run.
  const q = String.fromCharCode(39);
  const port = String(8000 + 894);
  const line = `  assert.equal(offendingLines(${q}  spawn(node, [ENTRY, "--port", "${port}"]);${q}).length, 1);`;
  assert.deepEqual(daemonSpawns(line), [], "a spawn inside a string literal was scanned as code");
});
