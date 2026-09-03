#!/usr/bin/env node
// aify-env-doctor: what this environment can say about itself, and what each registered service said.
//
// A COLLECTOR AND A DISPLAY, not an inspector. It answers its own questions — can this host open a
// terminal, can it read the registry, is an environment running — and for everything else it knocks
// and relays. A component that inspects another component's internals has taken on that component's
// concern, and across four repos that is how one of them ends up unable to ship without the others.
//
//   aify-env-doctor            human-readable
//   aify-env-doctor --json     {summary, counts, exitCode, checks:[{id, state, detail, fix}]}
//   aify-env-doctor --strict   exit non-zero when anything failed OR went unanswered
//
// Exit statuses are the contract: 0 all passed, 1 something failed, 2 something could not be answered.
// The third one exists because a check that gathered no evidence has not passed, and a verifier whose
// green means "some of this was unverifiable" stops being worth running.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EXIT, summarise } from "../lib/health.mjs";
// THE COLLECTION LIVES IN A MODULE so something other than a terminal can have it -- the TUI asks
// for exactly this (A3) and could not call a script. What stays here is the DISPLAY, which is the
// seam this file's own header has always named.
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { credentialRoot, listCredentialStore } from "../lib/credential-fs.mjs";
import { terminalSupport } from "../lib/runner.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

const REGISTRY_PATH = process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json");
const ENV_ENDPOINT = process.env.AIFY_ENV_ENDPOINT || "http://127.0.0.1:8802";
/** Short: a probe that hangs is a probe that turned a verifier into a wait. */
const PROBE_TIMEOUT_MS = Number(process.env.AIFY_PROBE_TIMEOUT_MS || 2000);

function readRegistry() {
  try {
    return { text: readFileSync(REGISTRY_PATH, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { readError: `${error.code ?? error.message}` };
  }
}

/** One HTTP knock, reduced to the three things a check cares about. */
async function knock(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: true, body, status: response.status };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "timed out" : (error.cause?.code ?? error.message) };
  }
}

const checks = await collectEnvironmentChecks({
  endpoint: ENV_ENDPOINT,
  knock,
  readRegistry,
  terminalSupport,
  readCredentialStore: () => listCredentialStore(credentialRoot()),
});

const result = summarise(checks);

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const mark = { passed: "  ok  ", failed: " FAIL ", unanswered: "  ??  " };
  for (const check of result.checks) {
    process.stdout.write(`${mark[check.state]} ${check.id.padEnd(14)} ${check.detail}\n`);
    if (check.fix) process.stdout.write(`${" ".repeat(8)}${" ".repeat(15)}fix: ${check.fix}\n`);
  }
  process.stdout.write(`\n${result.summary}\n`);
}

// Without --strict the exit is always 0: a report you run to look at should not fail a shell script
// that merely wanted to look. With it, unanswered counts, because that is the whole point of having
// the state at all.
process.exit(strict ? result.exitCode : EXIT.OK);
