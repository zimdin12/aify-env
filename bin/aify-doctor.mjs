#!/usr/bin/env node
// aify-doctor: what this environment can say about itself, and what each registered service said.
//
// A COLLECTOR AND A DISPLAY, not an inspector. It answers its own questions — can this host open a
// terminal, can it read the registry, is an environment running — and for everything else it knocks
// and relays. A component that inspects another component's internals has taken on that component's
// concern, and across four repos that is how one of them ends up unable to ship without the others.
//
//   aify-doctor            human-readable
//   aify-doctor --json     {summary, counts, exitCode, checks:[{id, state, detail, fix}]}
//   aify-doctor --strict   exit non-zero when anything failed OR went unanswered
//
// Exit statuses are the contract: 0 all passed, 1 something failed, 2 something could not be answered.
// The third one exists because a check that gathered no evidence has not passed, and a verifier whose
// green means "some of this was unverifiable" stops being worth running.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EXIT, failed, passed, summarise, unanswered } from "../lib/health.mjs";
import { ownedProcessesCheck, registryCheck, terminalCheck } from "../lib/environment-checks.mjs";
import { probeService, readServices } from "../lib/services.mjs";
import { terminalSupport } from "../lib/runner.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

const REGISTRY_PATH = process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json");
const ENV_ENDPOINT = process.env.AIFY_ENV_ENDPOINT || "http://127.0.0.1:8801";
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

const checks = [];
checks.push(terminalCheck(terminalSupport()));

const source = readRegistry();
checks.push(registryCheck(source));

// Is an environment running? We can tell, so a silent listener is a FAILURE rather than an unanswered:
// nothing is listening is a fact, and the remedy is to start one.
const envAnswer = await knock(`${ENV_ENDPOINT}/health`);
if (envAnswer.ok) {
  checks.push(passed("environment", `an environment is running at ${ENV_ENDPOINT}`));
  const owned = Array.isArray(envAnswer.body?.processes) ? envAnswer.body.processes : [];
  const unknown = Array.isArray(envAnswer.body?.unknown) ? envAnswer.body.unknown : [];
  checks.push(ownedProcessesCheck({ owned, unknown }));
} else {
  checks.push(failed(
    "environment",
    `no environment is running at ${ENV_ENDPOINT}: ${envAnswer.error}`,
    "Start one with: aify-env",
  ));
  // Not a guess of zero. Nobody asked the thing that owns processes, so nobody knows.
  checks.push(unanswered("processes", "no environment answered, so what it owns is unknown"));
}

for (const service of readServices(source.text ?? "")) {
  checks.push(probeService(service, await knock(`${service.endpoint}/health`)));
}

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
