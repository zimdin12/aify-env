#!/usr/bin/env node
/**
 * `aify-env registry check` -- whether a candidate services.json holds anything this tier would misread.
 *
 * A WRITER ASKS BEFORE IT PUBLISHES (guided-install S1, step 4). aify-wrapper's `connect` builds a candidate, runs
 * its own parser on it, and then runs this, so the fields aify-env reads are checked by the tier that reads them.
 * The rules are in `lib/registry-check.mjs`; this file reads the candidate and the store, and prints the answer.
 *
 * THE STORE IS ASKED TOO. A reference whose file is missing, unreadable or loosely held is the case where the
 * registry and the store disagree -- a staged key that never landed, say -- and it is refused here rather than found
 * by a 401 later. Only STATES are reported, never a value: the store's readers name problems, not keys.
 *
 * ONE SERVICE AT A TIME, WHEN ASKED (`--service <name>`). A writer connecting one service must not be blocked by
 * another service's missing key file -- the install asks only for what it cannot find. With `--service`, the store
 * is a requirement for that service's references only; another service's missing file is a WARNING. Grammar,
 * collisions and advertising stay refusals for every service, since they are about this candidate, not the store.
 * Without `--service` every reference must be in the store, which is the doctor-style full check.
 *
 * THE CANDIDATE ALONE, WHEN ASKED (`--candidate-only`). Connect's prepare step does no credential I/O, so it needs
 * the rules without the store: grammar, version, collisions and advertising, and the credential store is never
 * opened. Each reference's `store` is then null, meaning not asked. `--service` scopes the store, so the two together
 * are a usage error.
 *
 * A CANDIDATE THAT WAS EVALUATED is answered with one JSON document on stdout,
 * `{check, ok, references, problems, warnings}`: exit 0 when ok, 65 when not, and warnings never change the exit.
 * A usage error (exit 64) and a candidate that could not be read (exit 65) print to stderr only, with no JSON.
 * The candidate comes from a file argument or `--stdin`.
 */

import fs from "node:fs/promises";
import process from "node:process";

import { CREDENTIAL_OK } from "../lib/credential-store.mjs";
import { credentialRoot, readCredentialFile } from "../lib/credential-fs.mjs";
import { REGISTRY_CHECK_VERSION, registryCandidateProblems } from "../lib/registry-check.mjs";

export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_FAILED = 65;

/** A registry is a small shared file; anything this large is the wrong file. */
export const MAX_REGISTRY_BYTES = 1024 * 1024;

const EOL = String.fromCharCode(10);
const USAGE = [
  "usage:",
  "  aify-env registry check <file|--stdin> [--service <name>]",
  "  aify-env registry check <file|--stdin> --candidate-only",
  "An evaluated candidate prints {check, ok, references, problems, warnings} as JSON: exit 0 ok, 65 problems.",
  "A usage error (64) or an unreadable candidate (65) prints to stderr only.",
  "--service requires only that service's references to be in the store; others' missing files are warnings.",
  "--candidate-only checks the candidate alone and never opens the credential store.",
].join(EOL);

/** argv into an intent. PURE. */
export function parseRegistryArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const options = { action: args[0] || "", file: "", stdin: false, service: "", candidateOnly: false, problem: "" };
  if (options.action !== "check") {
    options.problem = options.action ? `unknown action '${options.action}'` : "no action given";
    return options;
  }
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--stdin") options.stdin = true;
    else if (arg === "--candidate-only") options.candidateOnly = true;
    else if (arg === "--service" || arg.startsWith("--service=")) {
      // The = form is one token, so a name beginning with - has an exact spelling. Empty is refused, never "all".
      options.service = arg === "--service" ? String(rest[++i] ?? "") : arg.slice("--service=".length);
      if (!options.service || (arg === "--service" && options.service.startsWith("--"))) {
        options.problem = "--service needs a service name";
        return options;
      }
    } else if (arg.startsWith("-")) { options.problem = `unknown argument '${arg}'`; return options; }
    else if (options.file) { options.problem = "check takes one file"; return options; }
    else options.file = arg;
  }
  if (options.stdin === Boolean(options.file)) options.problem = "check needs one file or --stdin";
  else if (options.candidateOnly && options.service) {
    options.problem = "--candidate-only opens no store, so --service has nothing to scope";
  }
  return options;
}

async function readBounded(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_REGISTRY_BYTES) throw new Error(`more than ${MAX_REGISTRY_BYTES} bytes arrived on stdin`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The whole answer for one candidate: the pure rules, then each accepted reference's state in the store.
 * `readState(ref)` is injected so the store half is testable; the command passes the real store.
 * `service`, when given, scopes the store requirement to that service (see the header); a name the candidate does
 * not hold is refused, so a typo cannot turn every store fault into a warning.
 */
export async function checkRegistry(text, readState, { service = "" } = {}) {
  const { services, references, problems } = registryCandidateProblems(text);
  const warnings = [];
  if (service && services && !services.includes(service)) {
    problems.push({ code: "service-absent", service, field: null, detail: "the candidate holds no entry by this name" });
  }
  const checked = [];
  for (const reference of references) {
    const { state, detail } = await readState(reference.ref);
    checked.push({ ...reference, store: state });
    if (state !== CREDENTIAL_OK) {
      const finding = { code: "credential-store", service: reference.service, field: reference.field,
        detail: detail ? `${state}: ${detail}` : state };
      (service && reference.service !== service ? warnings : problems).push(finding);
    }
  }
  return { check: REGISTRY_CHECK_VERSION, ok: problems.length === 0, references: checked, problems, warnings };
}

/** The candidate alone: the pure rules and nothing else, in the same shape. Never opens the store. PURE. */
export function checkCandidate(text) {
  const { references, problems } = registryCandidateProblems(text);
  return { check: REGISTRY_CHECK_VERSION, ok: problems.length === 0,
    references: references.map((reference) => ({ ...reference, store: null })), problems, warnings: [] };
}

async function main() {
  const options = parseRegistryArgs(process.argv.slice(2));
  if (options.problem) {
    process.stderr.write(`aify-env registry: ${options.problem}${EOL}${USAGE}${EOL}`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  let text;
  try {
    if (options.stdin) text = await readBounded(process.stdin);
    else {
      const stat = await fs.stat(options.file);
      if (stat.size > MAX_REGISTRY_BYTES) throw new Error(`${options.file} is over ${MAX_REGISTRY_BYTES} bytes`);
      text = await fs.readFile(options.file, "utf8");
    }
  } catch (failure) {
    process.stderr.write(`aify-env registry: ${failure.message}${EOL}`);
    process.exitCode = EXIT_FAILED;
    return;
  }
  const answer = options.candidateOnly
    ? checkCandidate(text)
    : await checkRegistry(text, (ref) => readCredentialFile({ root: credentialRoot(), ref }), { service: options.service });
  process.stdout.write(`${JSON.stringify(answer, null, 2)}${EOL}`);
  process.exitCode = answer.ok ? EXIT_OK : EXIT_FAILED;
}

// Only when RUN, so tests import the helpers without reading the operator's store (see aify-env-credential.mjs).
if (process.argv[1] && process.argv[1].endsWith("aify-env-registry.mjs")) {
  await main();
}
