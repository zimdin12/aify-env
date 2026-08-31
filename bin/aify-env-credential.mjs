#!/usr/bin/env node
/**
 * `aify-env credential` -- the public way to put a service's key into this host's store.
 *
 * WHY THIS COMMAND EXISTS RATHER THAN THE CALLER WRITING THE FILE. aify-comms' installer is the one
 * component that resolves the effective key, so it owns the VALUE; this daemon owns the store, its
 * path resolution, its ACLs and its atomic write. A caller that wrote the file itself would be
 * reimplementing custody rules in a second place and in another language, and the two would agree
 * only until one of them was fixed.
 *
 * THE SECRET TRAVELS ON STDIN AND NOWHERE ELSE. Not argv, which every process on the host can read
 * from the process table for as long as the command runs; not the environment, which children
 * inherit; not this command's output, not its errors, not the registry, not `/health`. `--stdin` is
 * REQUIRED rather than defaulted, so a caller cannot reach the value-passing path by accident and
 * there is no flag to be tempted by.
 *
 * WHAT IT PRINTS ON SUCCESS is the REFERENCE, which is not a secret: it is the name the registry
 * will carry so this daemon can find the file again. That is the join between the two tiers, and it
 * travels in the clear on purpose.
 */

import process from "node:process";

import {
  CREDENTIAL_OK,
  MAX_CREDENTIAL_BYTES,
  credentialRefProblem,
  defaultCredentialRef,
} from "../lib/credential-store.mjs";
import {
  credentialRoot,
  listCredentialFiles,
  readCredentialFile,
  removeCredentialFile,
  writeCredentialFile,
} from "../lib/credential-fs.mjs";

const EOL = String.fromCharCode(10);

/** Exit codes a caller can branch on without parsing prose. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_FAILED = 65;

const USAGE = [
  "usage:",
  "  aify-env credential set --service <name> --stdin [--ref <name>]",
  "  aify-env credential status [--service <name>]",
  "  aify-env credential remove --service <name> [--ref <name>]",
  "",
  "The key is read from STDIN. There is deliberately no flag that takes it: argv is readable by",
  "every process on the host for as long as the command runs.",
].join(EOL);

/**
 * Parse argv into an intent. PURE, so the argument rules are testable without running a command
 * that writes to the operator's home directory.
 */
export function parseCredentialArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const action = args[0] || "";
  const options = { action, service: "", ref: "", stdin: false, problem: "" };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--stdin") { options.stdin = true; continue; }
    if (arg === "--service") { options.service = String(args[i + 1] || ""); i += 1; continue; }
    if (arg === "--ref") { options.ref = String(args[i + 1] || ""); i += 1; continue; }
    // A FLAG THAT WOULD CARRY THE SECRET IS REFUSED BY NAME, rather than merely unsupported. An
    // unknown flag that gets ignored is how somebody ends up with the key in their shell history
    // and in the process table, believing it worked -- it did work, and that is the problem.
    if (/^--(key|value|secret|password|token)(=|$)/.test(arg)) {
      options.problem = `${arg.split("=")[0]} would put the key in argv, where every process on `
        + "this host can read it. Pipe it on stdin instead.";
      return options;
    }
    options.problem = `unknown argument '${arg}'`;
    return options;
  }
  if (!["set", "status", "remove"].includes(action)) {
    options.problem = action ? `unknown action '${action}'` : "no action given";
    return options;
  }
  if (action !== "status" && !options.service) {
    options.problem = `${action} needs --service <name>`;
    return options;
  }
  if (action === "set" && !options.stdin) {
    options.problem = "set needs --stdin: the key is read from standard input, never from argv";
    return options;
  }
  if (options.ref) {
    const bad = credentialRefProblem(options.ref);
    if (bad) options.problem = `--ref ${bad}`;
  }
  return options;
}

/** The reference for a service: what the caller asked for, else one derived from the name. */
export function referenceFor({ service = "", ref = "" } = {}) {
  if (ref) return credentialRefProblem(ref) ? "" : ref;
  return defaultCredentialRef(service);
}

/**
 * Read stdin, ABORTING once it exceeds the limit rather than buffering whatever arrives.
 *
 * The first version buffered everything and let the store's size check run afterwards, which is a
 * check that happens after the damage: anything piped in was already in this process's memory, and
 * a caller redirecting the wrong file could hand it a gigabyte before being told it was too big.
 *
 * Decoding is STRICT and happens here rather than through `Buffer.toString`, which substitutes
 * U+FFFD for invalid bytes -- turning a mis-encoded key into a plausible one that matches nothing.
 * That is the same substitution the store already refuses when reading a file, and it has to be
 * refused on the way in too, or the store would faithfully persist a key nobody issued.
 */
export async function readStdinBounded(stream, limit = MAX_CREDENTIAL_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) {
      throw new Error(`more than ${limit} bytes arrived on stdin; a key is a token, not a file`);
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("what arrived on stdin is not valid UTF-8");
  }
}

/**
 * A key typed by a person arrives with the newline they pressed. Exactly ONE trailing line ending is
 * removed -- and nothing else, because trimming freely is how a key with a stray character becomes a
 * DIFFERENT key that this host stores and the service never issued.
 */
export function keyFromStdin(text) {
  let value = String(text ?? "");
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

async function main() {
  const options = parseCredentialArgs(process.argv.slice(2));
  if (options.problem) {
    process.stderr.write(`aify-env credential: ${options.problem}${EOL}${USAGE}${EOL}`);
    process.exit(EXIT_USAGE);
  }

  const root = credentialRoot();

  if (options.action === "status") {
    // NAMES AND STATES, never values. This is what an operator and the doctor read.
    const names = options.service
      ? [referenceFor(options)].filter(Boolean)
      : await listCredentialFiles(root);
    if (!names.length) {
      process.stdout.write(`no credentials stored in ${root}${EOL}`);
      process.exit(EXIT_OK);
    }
    // LISTS EVERYTHING, EXITS NON-ZERO IF ANY OF IT IS FAULTED. A human wants the whole picture;
    // automation needs a verdict, and exiting 0 while printing CREDENTIAL_INSECURE is the shape
    // where a script reports the store healthy because the command "worked".
    let faulted = 0;
    for (const name of names) {
      const answer = await readCredentialFile({ root, ref: name });
      const detail = answer.detail ? ` -- ${answer.detail}` : "";
      process.stdout.write(`${name}: ${answer.state}${detail}${EOL}`);
      if (answer.state !== CREDENTIAL_OK) faulted += 1;
    }
    process.exit(faulted ? EXIT_FAILED : EXIT_OK);
  }

  const ref = referenceFor(options);
  if (!ref) {
    process.stderr.write(
      `aify-env credential: no usable reference for service '${options.service}'${EOL}`);
    process.exit(EXIT_USAGE);
  }

  if (options.action === "remove") {
    const removed = await removeCredentialFile({ root, ref });
    if (!removed.ok) {
      process.stderr.write(`aify-env credential: ${removed.detail}${EOL}`);
      process.exit(EXIT_FAILED);
    }
    process.stdout.write(`removed ${ref}${EOL}`);
    process.exit(EXIT_OK);
  }

  let piped;
  try {
    piped = await readStdinBounded(process.stdin);
  } catch (failure) {
    // Names the PROBLEM, never what arrived.
    process.stderr.write(`aify-env credential: ${failure.message}${EOL}`);
    process.exit(EXIT_FAILED);
  }
  const value = keyFromStdin(piped);
  const written = await writeCredentialFile({ root, ref, value });
  if (!written.ok) {
    // The store's messages name the PROBLEM and never the value; this passes them through unchanged
    // rather than re-wording them into something that might quote what it refused.
    process.stderr.write(`aify-env credential: ${written.state}: ${written.detail}${EOL}`);
    process.exit(EXIT_FAILED);
  }
  // THE REFERENCE, not the key. This is what the caller records in its own registry entry, and it
  // is the whole reason this command prints anything at all.
  process.stdout.write(`${ref}${EOL}`);
  process.exit(EXIT_OK);
}

// Only when RUN, so the parsing helpers above can be imported by tests without the command
// executing against the operator's real home directory.
if (process.argv[1] && process.argv[1].endsWith("aify-env-credential.mjs")) {
  await main();
}
