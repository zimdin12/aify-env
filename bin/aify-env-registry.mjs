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
 * Output is one JSON document on stdout, `{check, ok, references, problems}`. Exit 0 when ok, 65 when not, 64 for a
 * usage error. The candidate comes from a file argument or, with `--stdin`, standard input.
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
  "  aify-env registry check <file>",
  "  aify-env registry check --stdin",
  "Prints {check, ok, references, problems} as JSON. Exit 0 ok, 65 problems, 64 usage.",
].join(EOL);

/** argv into an intent. PURE. */
export function parseRegistryArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const options = { action: args[0] || "", file: "", stdin: false, problem: "" };
  if (options.action !== "check") {
    options.problem = options.action ? `unknown action '${options.action}'` : "no action given";
    return options;
  }
  for (const arg of args.slice(1)) {
    if (arg === "--stdin") options.stdin = true;
    else if (arg.startsWith("-")) { options.problem = `unknown argument '${arg}'`; return options; }
    else if (options.file) { options.problem = "check takes one file"; return options; }
    else options.file = arg;
  }
  if (options.stdin === Boolean(options.file)) options.problem = "check needs one file or --stdin";
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
 */
export async function checkRegistry(text, readState) {
  const { references, problems } = registryCandidateProblems(text);
  const checked = [];
  for (const reference of references) {
    const { state, detail } = await readState(reference.ref);
    checked.push({ ...reference, store: state });
    if (state !== CREDENTIAL_OK) {
      problems.push({ code: "credential-store", service: reference.service, field: reference.field,
        detail: detail ? `${state}: ${detail}` : state });
    }
  }
  return { check: REGISTRY_CHECK_VERSION, ok: problems.length === 0, references: checked, problems };
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
  const root = credentialRoot();
  const answer = await checkRegistry(text, (ref) => readCredentialFile({ root, ref }));
  process.stdout.write(`${JSON.stringify(answer, null, 2)}${EOL}`);
  process.exitCode = answer.ok ? EXIT_OK : EXIT_FAILED;
}

// Only when RUN, so tests import the helpers without reading the operator's store (see aify-env-credential.mjs).
if (process.argv[1] && process.argv[1].endsWith("aify-env-registry.mjs")) {
  await main();
}
