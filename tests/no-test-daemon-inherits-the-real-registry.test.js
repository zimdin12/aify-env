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

/** Every `spawn(...)` whose argv mentions the daemon entry point. */
function daemonSpawns(text) {
  const out = [];
  let at = 0;
  for (;;) {
    const found = text.indexOf("spawn(", at);
    if (found < 0) return out;
    // The call's arguments, to its matching paren -- crude but sufficient: these are hand-written
    // test files, not generated code.
    let depth = 0;
    let end = found;
    for (let i = found + "spawn".length; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const call = text.slice(found, end + 1);
    at = end + 1;
    if (/DAEMON|aify-env\.mjs/.test(call)) out.push(call);
  }
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
      const sealed = /sealedDaemonEnv|AIFY_SERVICE_REGISTRY/.test(call);
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
