#!/usr/bin/env node
// What a native program receives when an operator pastes the doctor's command into Bash (aify-dashboard
// docs/DESIGN-SECRETS-INJECTION.md, "The doctor's credential advice: correction plan 2, revision 2").
//
// THE REAL TRANSPORT, A HARMLESS END. Each printed command runs through real Bash. Only its program name is swapped
// for a `sh` launcher shaped like the one npm generates for a bin (`exec node <bin> "$@"`), whose bin is a sink that
// writes the argv it received. The expectation is built here from the identity the registry holds, never from the
// doctor's text. The received argv then goes through the real parser. `aify-env credential` never runs.
//
// TWO ARMS. The command as printed, which carries MSYS2_ARG_CONV_EXCL='*', must arrive exactly. The same command
// without that prefix, in an environment with no conversion controls, is the control: on an MSYS host it must show a
// path-shaped argument converted, which proves this instrument can see conversion at all. On a host that converts
// nothing that arm says so and earns no credit, and a host with no Bash skips both, earning none either.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCredentialArgs, referenceFor } from "../bin/aify-env-credential.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";

const BASH = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:/Program Files", "Git", "bin", "bash.exe") : "/bin/bash";
const noBash = !fs.existsSync(BASH) && `no Bash at ${BASH}, so no native argv is observed here`;
const posix = (p) => p.replace(/\\/g, "/");

// The identities: each service's missing secrets ref, and one orphan. The second carries a dashed ref.
const SERVICES = ["demo service", "-lead", "/review-literal", "C:/x", "//share/x", 'q"$\\x'];
const refOf = (i) => (i === 1 ? "--fetch-key" : `key-${i}`);
const EXPECTED = [
  ...SERVICES.map((service, i) => ["credential", "set", `--service=${service}`, `--ref=${refOf(i)}`, "--stdin"]),
  ["credential", "remove", "--ref=--orphan-key"],
];

async function printedCommands() {
  const missing = Object.fromEntries(SERVICES.map((name, i) => [name, { endpoint: "http://127.0.0.2/x", secretsCredentialRef: refOf(i) }]));
  const keeper = { keeper: { endpoint: "http://127.0.0.2/x", credentialRef: "live" } };
  const fixes = [];
  // First every service's missing key, then one stored orphan beside a stored live key.
  for (const [services, names] of [[missing, []], [keeper, ["live", "--orphan-key"]]]) {
    const checks = await collectEnvironmentChecks({
      endpoint: "http://example.invalid", knock: async () => ({ ok: false, error: "down" }),
      readRegistry: () => ({ text: JSON.stringify({ version: 1, services }) }),
      terminalSupport: () => ({ available: true }), readCredentialStore: async () => ({ names }),
    });
    fixes.push(checks.find((check) => check.id === "credentials").fix);
  }
  return fixes.flatMap((fix) => [...String(fix).matchAll(/In Bash: `([^`]*)`/g)].map((match) => match[1]));
}

function sink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doctor-argv-"));
  const bin = path.join(dir, "sink.mjs");
  fs.writeFileSync(bin, 'import fs from "node:fs";\nfs.writeFileSync(process.env.SINK_OUT, JSON.stringify(process.argv.slice(2)));\n');
  const launcher = path.join(dir, "aify-env");
  fs.writeFileSync(launcher, '#!/bin/sh\nexec "$NODE_FOR_SINK" "$SINK" "$@"\n', { mode: 0o755 });
  let n = 0;
  /** What the sink received when Bash ran `line` with the program swapped for the launcher. */
  return (line) => {
    n += 1;
    const out = path.join(dir, `received-${n}.json`);
    const swapped = line.replace(/(^| )aify-env( |$)/, (_, before, after) => `${before}'${posix(launcher)}'${after}`);
    assert.notEqual(swapped, line, "the program name was found and swapped");
    // A clean environment: no MSYS_NO_PATHCONV and no MSYS2_ARG_CONV_EXCL unless the line itself sets one.
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", NODE_FOR_SINK: posix(process.execPath), SINK: posix(bin), SINK_OUT: posix(out) };
    const ran = spawnSync(BASH, ["-c", swapped], { env, encoding: "utf8" });
    assert.equal(ran.status, 0, `${swapped}\n${ran.stderr}`);
    return JSON.parse(fs.readFileSync(out, "utf8"));
  };
}

test("AS PRINTED, each command reaches a native program with exactly the argv the identity calls for", { skip: noBash }, async (t) => {
  const version = spawnSync(BASH, ["-c", "echo \"$BASH_VERSION $(uname -o)\""], { encoding: "utf8" }).stdout.trim();
  t.diagnostic(`bash: ${BASH}, ${version}`);
  const lines = await printedCommands();
  assert.equal(lines.length, EXPECTED.length, lines.join("\n"));
  const received = sink();
  const got = lines.map((line) => received(line));
  assert.deepEqual([...got].sort(), [...EXPECTED].sort(), "every argv arrived exactly");
  for (const argv of got) {
    const options = parseCredentialArgs(argv.slice(1));
    assert.equal(options.problem, "", JSON.stringify(argv));
    const want = EXPECTED.find((expected) => JSON.stringify(expected) === JSON.stringify(argv));
    assert.equal(referenceFor(options), want.find((word) => word.startsWith("--ref=")).slice("--ref=".length));
    if (options.action === "set") assert.equal(options.service, want[2].slice("--service=".length));
  }
});

test("THE CONTROL: without the printed protection, an MSYS host converts a path-shaped argument", { skip: noBash }, async (t) => {
  const msys = spawnSync(BASH, ["-c", "uname -o"], { encoding: "utf8" }).stdout.trim() === "Msys";
  if (!msys) { t.diagnostic("this host's Bash converts nothing, so this arm earns no credit"); return; }
  const line = (await printedCommands()).find((printed) => printed.includes("/review-literal"));
  assert.ok(line.startsWith("MSYS2_ARG_CONV_EXCL='*' "), line);
  const got = sink()(line.slice("MSYS2_ARG_CONV_EXCL='*' ".length));
  assert.notEqual(got[2], "--service=/review-literal", `the instrument sees conversion: ${got[2]}`);
});
