// `aify-env registry check`: a writer asks this tier before publishing a services.json (guided-install S1, step 4).
//
// WHY IT EXISTS. aify-wrapper's `parseRegistry` drops fields it does not normalise, `secretsCredentialRef` and
// `advertise` among them, and aify-env reads both. Validated only by the wrapper, a bad value in either reached the
// shared registry and surfaced later as a 401 or a /health note. Each rule below names the defect it catches.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REGISTRY_CHECK_VERSION, registryCandidateProblems } from "../lib/registry-check.mjs";
import { checkRegistry, parseRegistryArgs } from "../bin/aify-env-registry.mjs";
import { CREDENTIAL_MISSING, CREDENTIAL_OK } from "../lib/credential-store.mjs";

const BIN = fileURLToPath(new URL("../bin/", import.meta.url));
const DISPATCHER = path.join(BIN, "aify-env.mjs");
const CREDENTIAL = path.join(BIN, "aify-env-credential.mjs");
const CANARY = "canary-key-DO-NOT-LEAK-7171";

const registry = (services, extra = {}) => JSON.stringify({ version: 1, services, ...extra });
const codes = (text) => registryCandidateProblems(text).problems.map((p) => `${p.code}:${p.service}:${p.field}`);
const comms = { endpoint: "http://127.0.0.1:8800", credentialRef: "aify-comms.key" };

test("a credential reference the store would refuse is refused, on the entry and inside its options", () => {
  assert.deepEqual(codes(registry({ d: { endpoint: "http://h", secretsCredentialRef: "../x" } })),
    ["credential-ref-invalid:d:secretsCredentialRef"]);
  // The sender reads `agentState.credentialRef`, so a reference one level down is the same file and the same grammar.
  assert.deepEqual(codes(registry({ d: { endpoint: "http://h", agentState: { path: "/a", credentialRef: "a/b" } } })),
    ["credential-ref-invalid:d:agentState.credentialRef"]);
  assert.deepEqual(codes(registry({ d: { endpoint: "http://h", credentialRef: 7 } })), ["credential-ref-invalid:d:credentialRef"]);
});

test("the field set is the store's shape rule, so a credential field nobody listed is still checked", () => {
  assert.deepEqual(codes(registry({ d: { endpoint: "http://h", relayCredentialRef: "has space" } })),
    ["credential-ref-invalid:d:relayCredentialRef"]);
});

test("two services whose references case-fold together are refused; one service may name its own file twice", () => {
  assert.deepEqual(codes(registry({ comms, dash: { endpoint: "http://h", secretsCredentialRef: "AIFY-COMMS.key" } })),
    ["credential-ref-collision:dash:secretsCredentialRef"]);
  // CONTROL: agentState's key is usually the entry's own, which is one file and one owner.
  assert.deepEqual(codes(registry({ comms: { ...comms, agentState: { path: "/a", credentialRef: "Aify-Comms.key" } } })), []);
});

test("an advertise value advertisingChoice would ignore is refused; false and absent are choices", () => {
  assert.deepEqual(codes(registry({ d: { endpoint: "http://h", advertise: "yes" } })), ["advertising-ignored:d:null"]);
  assert.deepEqual(codes(registry({ d: { endpoint: "http://h", advertise: false }, comms })), []);
});

test("a candidate that is not a registry of the version this tier reads is refused; an omitted version is read", () => {
  assert.deepEqual(codes("{not json"), ["unreadable:null:null"]);
  assert.deepEqual(codes(JSON.stringify({ version: 1 })), ["unreadable:null:null"]);
  assert.deepEqual(codes(registry({ comms }, { version: 2 })), ["version:null:version"]);
  assert.deepEqual(codes(JSON.stringify({ services: { comms } })), []);
});

test("an optional credential that is absent is a working state (S1 format freeze, item 2)", () => {
  const dashboard = { endpoint: "http://127.0.0.1:9700", credentialRef: "aify-dashboard.key", advertise: false };
  assert.deepEqual(codes(registry({ comms, "aify-dashboard": dashboard })), []);
});

test("every accepted reference is asked of the store, and a state other than ok is a problem", async () => {
  const text = registry({ comms, d: { endpoint: "http://h", secretsCredentialRef: "d-secrets.key" } });
  const states = { "aify-comms.key": CREDENTIAL_OK, "d-secrets.key": CREDENTIAL_MISSING };
  const answer = await checkRegistry(text, async (ref) => ({ state: states[ref], detail: "" }));
  assert.equal(answer.ok, false);
  assert.deepEqual(answer.references.map((r) => `${r.ref}=${r.store}`), ["aify-comms.key=ok", "d-secrets.key=CREDENTIAL_MISSING"]);
  assert.deepEqual(answer.problems.map((p) => `${p.code}:${p.service}:${p.field}`), ["credential-store:d:secretsCredentialRef"]);
});

test("--service scopes the store to one service: another's missing file warns, its own is refused", async () => {
  const text = registry({ comms, d: { endpoint: "http://h", credentialRef: "d.key" } });
  const states = { "aify-comms.key": CREDENTIAL_MISSING, "d.key": CREDENTIAL_OK };
  const readState = async (ref) => ({ state: states[ref], detail: "" });
  const scoped = await checkRegistry(text, readState, { service: "d" });
  assert.equal(scoped.ok, true);
  assert.deepEqual(scoped.problems, []);
  assert.deepEqual(scoped.warnings.map((w) => `${w.code}:${w.service}:${w.field}`), ["credential-store:comms:credentialRef"]);
  const own = await checkRegistry(text, readState, { service: "comms" });
  assert.deepEqual(own.problems.map((p) => `${p.code}:${p.service}`), ["credential-store:comms"]);
  assert.deepEqual(own.warnings, []);
  // CONTROL: without --service every reference must be in the store, the doctor-style check.
  assert.deepEqual((await checkRegistry(text, readState)).problems.map((p) => p.code), ["credential-store"]);
});

test("--service still refuses another service's collision, and a name the candidate does not hold", async () => {
  const ok = async () => ({ state: CREDENTIAL_OK, detail: "" });
  const colliding = registry({ comms, dash: { endpoint: "http://h", secretsCredentialRef: "AIFY-COMMS.key" } });
  const scoped = await checkRegistry(colliding, ok, { service: "comms" });
  assert.deepEqual(scoped.problems.map((p) => `${p.code}:${p.service}`), ["credential-ref-collision:dash"]);
  // A TYPO MUST NOT TURN EVERY STORE FAULT INTO A WARNING. An empty services object holds no name either.
  for (const text of [registry({ comms }), registry({})]) {
    assert.deepEqual((await checkRegistry(text, ok, { service: "comm" })).problems.map((p) => p.code), ["service-absent"]);
  }
});

test("check takes exactly one file or --stdin, and --service takes a name", () => {
  assert.equal(parseRegistryArgs(["check", "f.json"]).problem, "");
  assert.equal(parseRegistryArgs(["check", "--stdin"]).problem, "");
  assert.equal(parseRegistryArgs(["check", "f.json", "--service", "aify-dashboard"]).service, "aify-dashboard");
  assert.equal(parseRegistryArgs(["check", "--stdin", "--service=-odd"]).service, "-odd");
  for (const argv of [[], ["check"], ["check", "a", "b"], ["check", "a", "--stdin"], ["check", "--json"], ["verify", "a"],
    ["check", "a", "--service"], ["check", "a", "--service="], ["check", "a", "--service", "--stdin"]]) {
    assert.notEqual(parseRegistryArgs(argv).problem, "", argv.join(" "));
  }
});

/** Run a bin as a child with the store redirected under `home`, and report its REAL exit status. */
function run(args, { home, input = "" }) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60000 },
      () => {});
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("through the dispatcher: a staged key set by `credential set --ref` checks ok, a missing one exits 65, and no key is printed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-regcheck-"));
  // THE STAGED NAME connect will use (S1 step 2): `<service>-staged-<nonce>`, which the store's grammar accepts as is.
  const staged = "aify-dashboard-staged-0123456789abcdef";
  const stored = execFileSync(process.execPath, [CREDENTIAL, "set", "--service", "aify-dashboard", "--stdin", "--ref", staged],
    { input: CANARY, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60000 }).trim();
  assert.equal(stored, staged);

  const good = path.join(home, "good.json");
  fs.writeFileSync(good, registry({ "aify-dashboard": { endpoint: "http://127.0.0.1:9700", credentialRef: staged } }));
  const ok = await run([DISPATCHER, "registry", "check", good], { home });
  assert.equal(ok.code, 0, ok.stderr);
  const answer = JSON.parse(ok.stdout);
  assert.equal(answer.check, REGISTRY_CHECK_VERSION);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.references, [{ service: "aify-dashboard", field: "credentialRef", ref: staged, store: CREDENTIAL_OK }]);

  const viaStdin = await run([DISPATCHER, "registry", "check", "--stdin"], { home, input: fs.readFileSync(good, "utf8") });
  assert.equal(viaStdin.code, 0, viaStdin.stderr);

  const missing = await run([DISPATCHER, "registry", "check", "--stdin"],
    { home, input: registry({ "aify-dashboard": { endpoint: "http://h", credentialRef: "never-stored.key" } }) });
  assert.equal(missing.code, 65);
  assert.deepEqual(JSON.parse(missing.stdout).problems.map((p) => p.code), ["credential-store"]);

  // CONNECTING ONE SERVICE is not blocked by another's missing file: exit 0, and the other's fault is a warning.
  const both = registry({ "aify-dashboard": { endpoint: "http://127.0.0.1:9700", credentialRef: staged },
    comms: { endpoint: "http://127.0.0.1:8800", credentialRef: "never-stored.key" } });
  const scoped = await run([DISPATCHER, "registry", "check", "--stdin", "--service", "aify-dashboard"], { home, input: both });
  assert.equal(scoped.code, 0, scoped.stderr);
  assert.deepEqual(JSON.parse(scoped.stdout).warnings.map((w) => `${w.code}:${w.service}`), ["credential-store:comms"]);
  const named = await run([DISPATCHER, "registry", "check", "--stdin", "--service", "comms"], { home, input: both });
  assert.equal(named.code, 65);

  const usage = await run([DISPATCHER, "registry", "check"], { home });
  assert.equal(usage.code, 64);

  for (const out of [ok, viaStdin, missing, scoped, named, usage]) {
    assert.ok(!(out.stdout + out.stderr).includes(CANARY), "a stored key reached the command's output");
  }
});
