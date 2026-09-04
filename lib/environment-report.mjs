// Everything this environment can say about itself, COLLECTED — with nothing that prints or exits.
//
// `bin/aify-env-doctor.mjs` opens by naming its own seam: "A COLLECTOR AND A DISPLAY". Both halves
// lived in the script, so the collection could only be reached by RUNNING the doctor — which means
// the only consumer it could ever have is a terminal, and the only way to test it is to read stdout.
// This repo has made exactly this move once before, on aify-comms' `doctor.js`: its predicates were
// untestable until they moved out, and the first thing a test caught was a real bug.
//
// WHAT ASKED FOR IT. A3, the operator, 2026-08-24: the TUI should show what the doctor shows.
// `aify-env doctor` exists and works; the view could not call it, because there was nothing to call.
// Shelling out to the binary and parsing its text would have been the other option, and it is the
// worse one: a display parsing another display's output is a contract nobody declared, and it breaks
// the first time a column moves.
//
// EVERY INPUT IS INJECTED, and that is what makes this testable without a host. The doctor supplies
// the real readers; a test supplies fakes and drives the same code the operator runs. Nothing here
// reads an environment variable, opens a file, or holds a clock of its own.
//
// IT COLLECTS, IT DOES NOT JUDGE THE WHOLE. `summarise` decides the exit status and the counts; that
// is the display's business and the doctor still owns it. This returns the checks in the order they
// were gathered, because the order is the reading order and a set would lose it.

import { unanswered } from "./health.mjs";
import {
  advertiseCredentialCheck,
  claimingCheck,
  codeCurrentCheck,
  credentialStoreCheck,
  environmentCheck,
  looksLikeEnvironment,
  ownedProcessesCheck,
  registryCheck,
  terminalCheck,
} from "./environment-checks.mjs";
import { probeService, readServices, registryVersion, SUPPORTED_REGISTRY_VERSION } from "./services.mjs";

/**
 * @param {object} deps
 * @param {string} deps.endpoint              where this host's environment should be listening
 * @param {(url: string) => Promise<object>} deps.knock   one HTTP question, already budgeted
 * @param {() => object} deps.readRegistry    `{text}` | `{missing}` | `{readError}`
 * @param {() => object} deps.terminalSupport can this process open a real terminal
 * @param {() => Promise<object>} deps.readCredentialStore `{problem}` | `{names}`
 * @returns {Promise<object[]>} the checks, in reading order
 */
export async function collectEnvironmentChecks({
  endpoint,
  knock,
  readRegistry,
  terminalSupport,
  readCredentialStore,
}) {
  const checks = [];
  checks.push(terminalCheck(terminalSupport()));

  const source = readRegistry();
  checks.push(registryCheck(source));

  // Is an environment running? We can tell, so both a silent port and a WRONG occupant are failures
  // rather than unanswered: nothing listening is a fact, and something-else listening is a fact.
  const envAnswer = await knock(`${endpoint}/health`);
  checks.push(environmentCheck(endpoint, envAnswer));

  if (looksLikeEnvironment(envAnswer)) {
    const owned = Array.isArray(envAnswer.body?.processes) ? envAnswer.body.processes : [];
    const unknown = Array.isArray(envAnswer.body?.unknown) ? envAnswer.body.unknown : [];
    checks.push(ownedProcessesCheck({ owned, unknown }));
    // Reads what the daemon reports about ITSELF. The credential lives in its process environment, and
    // this doctor runs in a different process -- so asking our own environment would answer a question
    // nobody has, and would answer it wrongly whenever the two shells differ.
    checks.push(advertiseCredentialCheck({
      answered: true,
      enabled: envAnswer.body?.advertisingEnabled ?? null,
      credentials: envAnswer.body?.advertiseCredentials ?? null,
      attempts: envAnswer.body?.advertiseAttempts ?? null,
    }));
    // ADVERTISING AND CLAIMING ARE DIFFERENT CAPABILITIES, and this doctor only reported the first.
    // On 2026-09-02 the advertiser was healthy while every claim heartbeat was discarded, `/spawn`
    // refused six times, and a green `aify-env doctor` was part of what told the operator it was fine.
    checks.push(claimingCheck({ answered: true, plugins: envAnswer.body?.plugins ?? null }));
    // WHETHER THE RESTART TOOK, which is the question asked after every fix and which this doctor
    // could not answer. Both halves come from the daemon's own /health, so this compares what ONE
    // process says about itself rather than a report against a file somebody else read.
    checks.push(codeCurrentCheck({
      answered: true,
      build: envAnswer.body?.build ?? null,
      codeOnDisk: envAnswer.body?.codeOnDisk ?? null,
    }));
  } else {
    // Not a guess of zero, and the distinction is load-bearing: "0 processes owned" is what a healthy
    // idle environment looks like, so reporting it when no environment answered turns an absent
    // environment into a calm one.
    checks.push(unanswered("processes", "no aify-env answered, so what it owns is unknown"));
    checks.push(advertiseCredentialCheck({ answered: false }));
    checks.push(claimingCheck({ answered: false }));
    checks.push(codeCurrentCheck({ answered: false }));
  }

  // Only when the registry announces a format we understand. Probing entries pulled out of one we do
  // not is acting on a guess the registry check has just announced it would not make -- the report would
  // carry a row saying the file cannot be read and further rows naming services read out of it.
  const declaredVersion = registryVersion(source.text ?? "");
  const registryUnderstood = declaredVersion === null || declaredVersion === SUPPORTED_REGISTRY_VERSION;
  if (registryUnderstood) {
    for (const service of readServices(source.text ?? "")) {
      checks.push(probeService(service, await knock(`${service.endpoint}/health`)));
    }
  }

  // THE CREDENTIAL STORE, compared against what the registry references. Reported, never deleted: a
  // file nobody references today may be referenced by a registry that is briefly unreadable, and
  // deleting a population on that reasoning is how a cleanup becomes an outage.
  const store = await readCredentialStore();
  checks.push(credentialStoreCheck({
    storeProblem: store.problem,
    storeNames: store.problem ? null : store.names,
    registryRefs: registryUnderstood
      ? readServices(source.text ?? "").map((service) => service.credentialRef)
      : null,
  }));

  return checks;
}
