// `aify-env credential` -- the public way a caller puts a key into this host's store.
//
// THE ARGUMENT RULES ARE TESTED PURELY, and the command is driven as a real child process for the
// end-to-end shapes. That split is deliberate: importing the module must NOT run the command,
// because the command writes into the operator's real home directory, and a test that did that
// would leave a credential file behind on whoever ran the suite.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  keyFromStdin,
  parseCredentialArgs,
  referenceFor,
} from "../bin/aify-env-credential.mjs";

const COMMAND = fileURLToPath(new URL("../bin/aify-env-credential.mjs", import.meta.url));
const CANARY = "canary-key-DO-NOT-LEAK-9999";

/** Run the command with HOME pointed at a scratch directory, so the real store is never
 *  touched, and report its REAL exit code -- `execFile`'s promise form rejects on non-zero,
 *  which would turn every deliberate refusal below into a thrown error instead of a verdict. */
async function runCode(args, { input = "", home } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [COMMAND, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }, () => {});
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.end(input);
    child.on("close", (code) => resolve({ stdout: out, stderr: err, code }));
  });
}

function scratchHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-credcmd-"));
}

test("A FLAG THAT WOULD CARRY THE KEY IS REFUSED BY NAME, not merely unsupported", () => {
  // An unknown flag that gets ignored is how somebody ends up with the key in their shell history
  // and in the process table believing it worked -- it did work, and that is the problem.
  for (const flag of ["--key", "--value", "--secret", "--password", "--token"]) {
    const parsed = parseCredentialArgs(["set", "--service", "x", flag, CANARY]);
    assert.match(parsed.problem, /argv/, flag);
    assert.match(parsed.problem, /stdin/, flag);
  }
});

test("set REQUIRES --stdin, so the value-passing path cannot be reached by accident", () => {
  assert.match(parseCredentialArgs(["set", "--service", "x"]).problem, /--stdin/);
  assert.equal(parseCredentialArgs(["set", "--service", "x", "--stdin"]).problem, "");
});

test("an action or service that is missing is a usage error, not a guess", () => {
  assert.match(parseCredentialArgs([]).problem, /no action/);
  assert.match(parseCredentialArgs(["frobnicate"]).problem, /unknown action/);
  assert.match(parseCredentialArgs(["set", "--stdin"]).problem, /--service/);
  assert.match(parseCredentialArgs(["remove"]).problem, /--service/);
  // `status` alone is valid: it reports the whole store.
  assert.equal(parseCredentialArgs(["status"]).problem, "");
});

test("a --ref the grammar refuses is rejected at parse time", () => {
  assert.match(parseCredentialArgs(["set", "--service", "x", "--stdin", "--ref", "../a"]).problem,
               /--ref/);
  assert.equal(parseCredentialArgs(["set", "--service", "x", "--stdin", "--ref", "a.key"]).problem, "");
});

test("the reference is the caller's if given, else derived from the service name", () => {
  assert.equal(referenceFor({ service: "aify-comms" }), "aify-comms.key");
  assert.equal(referenceFor({ service: "aify-comms", ref: "chosen.key" }), "chosen.key");
  assert.equal(referenceFor({ service: "aify-comms", ref: "../escape" }), "",
               "a hostile ref was resolved instead of refused");
  assert.equal(referenceFor({ service: "..." }), "");
});

test("exactly ONE trailing line ending is removed from stdin, and nothing else", () => {
  // A key typed by a person arrives with the newline they pressed. Trimming freely is how a key with
  // a stray character becomes a DIFFERENT key that this host stores and the service never issued.
  assert.equal(keyFromStdin("abc\n"), "abc");
  assert.equal(keyFromStdin("abc\r\n"), "abc");
  assert.equal(keyFromStdin("abc"), "abc");
  assert.equal(keyFromStdin("abc\n\n"), "abc\n", "a second newline was swallowed");
  assert.equal(keyFromStdin("  abc  \n"), "  abc  ",
               "surrounding spaces were trimmed here instead of being refused by the store");
});

test("set prints the REFERENCE and never the key, and status does not either", async () => {
  const home = scratchHome();
  try {
    const set = await runCode(["set", "--service", "probe", "--stdin"], { input: `${CANARY}\n`, home });
    assert.equal(set.code, EXIT_OK, set.stderr);
    assert.equal(set.stdout.trim(), "probe.key");
    assert.ok(!`${set.stdout}${set.stderr}`.includes(CANARY), "the key reached the command's output");

    const status = await runCode(["status", "--service", "probe"], { home });
    assert.equal(status.code, EXIT_OK, status.stderr);
    assert.match(status.stdout, /probe\.key: ok/);
    assert.ok(!`${status.stdout}${status.stderr}`.includes(CANARY), "status printed the key");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the stored file holds exactly the key that was piped in", async () => {
  const home = scratchHome();
  try {
    await runCode(["set", "--service", "probe", "--stdin"], { input: `${CANARY}\n`, home });
    const stored = fs.readFileSync(path.join(home, ".aify", "credentials", "probe.key"), "utf8");
    // THE JOIN: what the writer put in is what a reader will get out, byte for byte plus the one
    // canonical newline. If these ever disagree the two tiers hold different keys and every call
    // 401s with both halves looking correctly configured.
    assert.equal(stored, `${CANARY}\n`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a key the store refuses fails loudly and writes nothing", async () => {
  const home = scratchHome();
  try {
    const set = await runCode(["set", "--service", "probe", "--stdin"], { input: "\n", home });
    assert.equal(set.code, EXIT_FAILED, set.stdout);
    assert.match(set.stderr, /CREDENTIAL_INVALID/);
    assert.equal(fs.existsSync(path.join(home, ".aify", "credentials", "probe.key")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("remove deletes exactly the named credential and reports it", async () => {
  const home = scratchHome();
  try {
    await runCode(["set", "--service", "a", "--stdin"], { input: `${CANARY}\n`, home });
    await runCode(["set", "--service", "b", "--stdin"], { input: `${CANARY}\n`, home });
    const removed = await runCode(["remove", "--service", "a"], { home });
    assert.equal(removed.code, EXIT_OK, removed.stderr);
    const store = path.join(home, ".aify", "credentials");
    assert.equal(fs.existsSync(path.join(store, "a.key")), false);
    assert.equal(fs.existsSync(path.join(store, "b.key")), true, "remove took the wrong file");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("status on an empty store says so rather than failing", async () => {
  const home = scratchHome();
  try {
    const status = await runCode(["status"], { home });
    assert.equal(status.code, EXIT_OK, status.stderr);
    assert.match(status.stdout, /no credentials stored/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a usage error exits with the usage code and prints how to do it right", async () => {
  const home = scratchHome();
  try {
    const bad = await runCode(["set", "--service", "x", "--key", CANARY], { home });
    assert.equal(bad.code, EXIT_USAGE);
    assert.match(bad.stderr, /stdin/);
    // Even the REFUSAL must not echo what it refused.
    assert.ok(!bad.stderr.includes(CANARY), "the refusal quoted the key back");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("importing the module does NOT run the command", async () => {
  // If it did, this suite would write a credential into whoever's home directory ran it -- and the
  // import at the top of this file would have done it before any test executed.
  const module = await import("../bin/aify-env-credential.mjs");
  assert.equal(typeof module.parseCredentialArgs, "function");
  assert.equal(EXIT_OK, 0);
});
