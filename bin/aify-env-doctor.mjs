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

import { EXIT, summarise, unanswered } from "../lib/health.mjs";
import {
  environmentCheck,
  looksLikeEnvironment,
  ownedProcessesCheck,
  registryCheck,
  terminalCheck,
} from "../lib/environment-checks.mjs";
import {
  probeService,
  readServices,
  registryVersion,
  SUPPORTED_REGISTRY_VERSION,
} from "../lib/services.mjs";
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

// Is an environment running? We can tell, so both a silent port and a WRONG occupant are failures
// rather than unanswered: nothing listening is a fact, and something-else listening is a fact.
const envAnswer = await knock(`${ENV_ENDPOINT}/health`);
checks.push(environmentCheck(ENV_ENDPOINT, envAnswer));

if (looksLikeEnvironment(envAnswer)) {
  const owned = Array.isArray(envAnswer.body?.processes) ? envAnswer.body.processes : [];
  const unknown = Array.isArray(envAnswer.body?.unknown) ? envAnswer.body.unknown : [];
  checks.push(ownedProcessesCheck({ owned, unknown }));
} else {
  // Not a guess of zero, and the distinction is load-bearing: "0 processes owned" is what a healthy
  // idle environment looks like, so reporting it when no environment answered turns an absent
  // environment into a calm one.
  checks.push(unanswered("processes", "no aify-env answered, so what it owns is unknown"));
}

// Only when the registry announces a format we understand. Probing entries pulled out of one we do
// not is acting on a guess the registry check has just announced it would not make -- the report would
// carry a row saying the file cannot be read and further rows naming services read out of it.
const declaredVersion = registryVersion(source.text ?? "");
if (declaredVersion === null || declaredVersion === SUPPORTED_REGISTRY_VERSION) {
  for (const service of readServices(source.text ?? "")) {
    checks.push(probeService(service, await knock(`${service.endpoint}/health`)));
  }
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
