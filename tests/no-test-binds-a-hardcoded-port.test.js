// No test may bind a daemon to a port it chose by hand.
//
// WHY THIS IS A GATE AND NOT A NOTE, measured 2026-09-03. Hardcoded ports failed BOTH ways on one
// day, and neither failure looked like what it was.
//
// FROM OUTSIDE: an unrelated program of the operator's -- `sand_castle.exe` -- was listening on
// 127.0.0.1:8894. `dashboard-opens-in-a-terminal.test.js` could not bind, the daemon printed
// nothing, and the test failed with `no banner:` and an empty string in the middle of an unrelated
// change in another repo. That reads exactly like a code regression, and it cost real time to
// attribute.
//
// FROM INSIDE: `a-second-start-supersedes-the-first.test.js` and
// `a-takeover-says-what-it-would-cost.test.js` BOTH used 8884 and 8885, and `node --test` runs files
// in parallel. The comment beside those constants claimed "a port nothing else in this suite uses",
// which was already false in the one dimension it asserted.
//
// So the rule everybody would have to remember is "pick a number nothing on any machine and no other
// file in this suite is using", which nobody can check. `_free-port.mjs` asks the OS instead, and
// this fails when a literal comes back.
//
// IT DOES NOT BAN PORT NUMBERS, only BINDING to one. A fixture naming `http://127.0.0.1:8800` is
// describing where aify-comms would be, not opening a socket, and several tests legitimately do
// that. The two shapes below are the ones that put a daemon on a port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Assigning a literal to a PORT binding, or passing one straight to `--port`.
 *
 * PORT 0 IS THE RIGHT ANSWER, NOT AN OFFENCE. It asks the OS for an ephemeral port, which is what
 * `freePort()` does one step earlier so the test can also KNOW the number. Most of this suite was
 * already doing that -- eight files pass `--port 0` -- so the hardcoded ones were the exception
 * rather than the convention, which is worth knowing before "fixing" a file that looks similar.
 */
const BINDS_A_LITERAL = [
  /\bconst\s+PORT\s*=\s*[1-9]\d*\s*;/,
  /["']--port["']\s*,\s*["']?[1-9]\d*["']?/,
];

/**
 * THE BLIND SPOT, named with the measurement rather than closed with a rule that would misfire.
 * A port bound under a DIFFERENT identifier -- `const P = 8885; spawn(..., String(P))` -- passes
 * both patterns. Widening to "any identifier assigned a number in 1024-65535" was measured against
 * the tree first and rejected: the only numeric consts in that range are `LIMIT = 1000` (a line
 * ceiling in the oversized-file gate) and `SELF = 4242` / `OTHER = 9999` in
 * `a-live-instances-record-survives-another-boot.test.js`, which are PIDs passed as `owner:` and
 * `self:`. A gate that fired on those would be switched off, and a gate switched off is worse than
 * a narrow one. No test names a port under another identifier today; if one ever does, this
 * paragraph is where to start.
 */

/** This file's own name: its controls are synthetic strings, not binds. */
const SELF = "no-test-binds-a-hardcoded-port.test.js";

function testFiles() {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(".test.js") || name.endsWith(".test.mjs"))
    .filter((name) => name !== SELF)
    .map((name) => ({ name, text: readFileSync(join(HERE, name), "utf8") }));
}

/** Lines that bind a hand-picked port, ignoring comments. */
function offendingLines(text) {
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => BINDS_A_LITERAL.some((re) => re.test(line)));
}

test("THE SCAN CAN SEE A HARDCODED PORT AT ALL", () => {
  // POSITIVE CONTROL. The assertion below is "no file does this", which an empty scan satisfies
  // perfectly -- and an empty scan is what a broken pattern returns. Both shapes are checked, because
  // the two files that carried this defect used one each.
  assert.equal(offendingLines("  const PORT = 8885;").length, 1, "the const shape is not matched");
  assert.equal(offendingLines('  spawn(node, [ENTRY, "--port", "8894"]);').length, 1,
    "the --port shape is not matched");
});

test("AND IT DOES NOT FIRE ON A PORT THAT IS ONLY NAMED, OR ON PORT 0", () => {
  // NEGATIVE CONTROL. Several tests describe where aify-comms would be listening; that is a fixture,
  // not a bind, and a gate that refused it would be switched off within a day. `--port 0` is the
  // ephemeral ask and is the behaviour this gate pushes people towards -- flagging it would point
  // every author at the one answer that is already correct.
  assert.deepEqual(offendingLines('  endpoint: "http://127.0.0.1:8800",'), []);
  assert.deepEqual(offendingLines('  const PORT = await freePort();'), []);
  assert.deepEqual(offendingLines('  // const PORT = 8885; kept for history'), []);
  // The token is deliberately NOT `DAEMON` or `aify-env.mjs`: the registry-seal gates scan every
  // test file for a spawn whose argv names the daemon and demand it be sealed, and this synthetic
  // control string tripped both of them. A fixture that looks like the thing another gate polices is
  // a fixture that breaks it.
  assert.deepEqual(offendingLines('  spawn(node, [BIN, "--port", "0"], {}); '), []);
});

test("NO TEST BINDS A HARDCODED PORT", () => {
  const offenders = [];
  for (const { name, text } of testFiles()) {
    for (const { line, n } of offendingLines(text)) {
      offenders.push(`${name}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    "a test binds a port it chose by hand. Any program on the host can already be holding it, and "
    + "`node --test` runs these files in parallel so another test can be holding it too -- both "
    + "produce a failure that reads like a code regression. Use `freePort()` from "
    + "`tests/_free-port.mjs`, calling it ONCE per test when two daemons must contend for one port.");
});
