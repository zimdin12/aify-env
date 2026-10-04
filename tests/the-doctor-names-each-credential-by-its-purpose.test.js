#!/usr/bin/env node
// The doctor's credentials row says which stored credential is missing or unreferenced, what it is for, and the exact
// command that targets it (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, "The doctor's credential advice:
// correction plan 2, revision 2").
//
// THE COMMANDS ARE CHECKED BY THE CONSUMER. Each printed command is split as Bash splits the subset the doctor emits,
// then parsed by the real `parseCredentialArgs` and resolved by the real `referenceFor`, which is what
// `aify-env credential` would act on. Nothing is set or removed. What a native program actually receives through Bash
// is the-doctors-commands-reach-the-cli-as-printed.test.js.

import assert from "node:assert/strict";
import test from "node:test";

import { parseCredentialArgs, referenceFor } from "../bin/aify-env-credential.mjs";
import { defaultCredentialRef } from "../lib/credential-store.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";
import { registryReferences } from "../lib/services.mjs";

const registry = (services, version = 1) => JSON.stringify({ ...(version === undefined ? {} : { version }), services: Object.fromEntries(Object.entries(services)
  .map(([name, entry]) => [name, { endpoint: `http://127.0.0.2/x`, ...entry }])) });

async function credentialsRow(source, names, { storeProblem = "" } = {}) {
  const checks = await collectEnvironmentChecks({
    endpoint: "http://example.invalid", knock: async () => ({ ok: false, error: "down" }),
    readRegistry: () => (typeof source === "string" ? { text: source } : source), terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => (storeProblem ? { problem: storeProblem } : { names }),
  });
  return checks.find((check) => check.id === "credentials");
}

/** A Bash word split of the subset the doctor emits: bare words, and words with whole single-quoted parts. PURE. */
function bashWords(line) {
  const words = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i += 1; continue; }
    let word = "";
    while (i < line.length && line[i] !== " ") {
      if (line[i] === "'") {
        const end = line.indexOf("'", i + 1);
        assert.ok(end > i, `a closed quote in ${line}`);
        word += line.slice(i + 1, end);
        i = end + 1;
      } else {
        word += line[i];
        i += 1;
      }
    }
    words.push(word);
  }
  return words;
}

/** Every command in a fix, as the real CLI would read its argv: actionable ones from Bash, the rest from their JSON. */
function commandsIn(fix) {
  const actionable = [...String(fix).matchAll(/In Bash: `([^`]*)`/g)].map((match) => {
    const words = bashWords(match[1]);
    assert.equal(words[0], "MSYS2_ARG_CONV_EXCL=*", "the protection is in the printed command");
    assert.deepEqual(words.slice(1, 3), ["aify-env", "credential"]);
    return { argv: words.slice(3), actionable: true };
  });
  const described = [...String(fix).matchAll(/cannot be printed safely for a shell; its arguments, as JSON, are (\[[^\]]*\])/g)]
    .map((match) => ({ argv: JSON.parse(match[1]).slice(2), actionable: false }));
  return [...actionable, ...described].map((command) => {
    const options = parseCredentialArgs(command.argv);
    return { ...command, action: options.action, problem: options.problem, service: options.service, ref: referenceFor(options) };
  });
}

const API = "an operation that authenticates to aify-dashboard with its API key cannot use it";
const FETCH = "a start whose definition names secrets cannot use this fetch credential";

test("A MISSING SECRETS KEY is named as the fetch credential, with the command that stores exactly it", async () => {
  // The bug: the fix said to re-run the installer with the API key, and that advertisements would be refused, for a
  // missing fetch key while the API key was usable.
  const row = await credentialsRow(registry({ "aify-dashboard": { credentialRef: "aify-dashboard", secretsCredentialRef: "dashboard-secrets" } }),
    ["aify-dashboard"]);
  assert.equal(row.state, STATE.FAILED);
  assert.ok(row.fix.includes(FETCH), row.fix);
  assert.match(row.fix, /API credential is separate and unaffected/);
  assert.doesNotMatch(row.fix, /installer|advertis|cannot use it until/i, "nothing of the API key's remedy");
  assert.deepEqual(commandsIn(row.fix).map((c) => [c.action, c.problem, c.service, c.ref]),
    [["set", "", "aify-dashboard", "dashboard-secrets"]]);
  assert.match(row.fix, /--stdin/);
});

test("A MISSING API KEY is named as the API key, conditionally, with the command that stores exactly it", async () => {
  const row = await credentialsRow(registry({ "aify-dashboard": { credentialRef: "aify-dashboard", secretsCredentialRef: "dashboard-secrets" } }),
    ["dashboard-secrets"]);
  assert.ok(row.fix.includes(API), row.fix);
  assert.doesNotMatch(row.fix, /fetch credential|names secrets/, "nothing of the fetch key's purpose");
  assert.doesNotMatch(row.fix, /refused|refuses/, "no observed refusal is claimed");
  assert.deepEqual(commandsIn(row.fix).map((c) => [c.action, c.service, c.ref]), [["set", "aify-dashboard", "aify-dashboard"]]);
});

test("a missing credential under any other *CredentialRef field gets no guessed purpose", async () => {
  const row = await credentialsRow(registry({ "aify-dashboard": { credentialRef: "aify-dashboard", laterCredentialRef: "later" } }), ["aify-dashboard"]);
  assert.match(row.fix, /later, named by aify-dashboard's laterCredentialRef\. Store it/);
  assert.doesNotMatch(row.fix, /cannot use|API key|fetch credential/);
  assert.deepEqual(commandsIn(row.fix).map((c) => [c.action, c.service, c.ref]), [["set", "aify-dashboard", "later"]]);
});

test("one missing ref named by several owners lists every owner and purpose; a case variant is one identity", async () => {
  // The join is the store's case-folded identity: `Shared` and `shared` are one file on a case-insensitive volume.
  const row = await credentialsRow(registry({
    "aify-dashboard": { credentialRef: "shared", secretsCredentialRef: "Shared" },
    "aify-graph": { credentialRef: "SHARED" },
  }), []);
  assert.match(row.detail, /^3 registry reference\(s\) name a credential that is not stored: SHARED, Shared, shared$/);
  assert.ok(row.fix.includes(API) && row.fix.includes(FETCH), row.fix);
  assert.ok(row.fix.includes("an operation that authenticates to aify-graph with its API key cannot use it"));
  assert.deepEqual(commandsIn(row.fix).map((c) => [c.service, c.ref]).sort(),
    [["aify-dashboard", "Shared"], ["aify-dashboard", "shared"], ["aify-graph", "SHARED"]]);
  const variant = await credentialsRow(registry({ "aify-dashboard": { credentialRef: "Dashboard-Secrets" } }), ["dashboard-secrets"]);
  assert.equal(variant.state, STATE.PASSED, variant.detail);
});

test("AN ORPHAN gets the exact --ref command, and the live default API key is not its target", async () => {
  // The bug: `credential remove --service aify-dashboard` resolved the live default API ref, not the orphan.
  const live = defaultCredentialRef("aify-dashboard");
  const row = await credentialsRow(registry({ "aify-dashboard": { credentialRef: live } }), [live, "dashboard-secrets"]);
  assert.match(row.detail, /no registry entry references: dashboard-secrets$/);
  const commands = commandsIn(row.fix);
  assert.deepEqual(commands.map((c) => [c.action, c.problem, c.ref]), [["remove", "", "dashboard-secrets"]]);
  assert.ok(!commands.some((c) => c.ref === live), "the live default is no command's target");
  assert.match(row.fix, /reported, never deleted/);
});

test("AN UNKNOWN REGISTRY leaves the row unanswered and prints no command", async () => {
  // The bug: a registry the doctor could not read was read as one naming nothing, so the live key was an orphan and a
  // removal command was printed for it. Each specimen has a confounder: a stored file a wrong reading would call one.
  const live = { "aify-dashboard": { credentialRef: "live-api" } };
  const specimens = [
    ["a read error", { readError: "EACCES" }],
    ["text that is not JSON", { text: "{not json" }],
    ["no services object", { text: JSON.stringify({ version: 1 }) }],
    ["a version given as the string \"1\"", { text: registry(live, "1") }],
    ["a version given as the string \"2\"", { text: registry(live, "2") }],
    ["an unsupported version 2", { text: registry(live, 2) }],
    ["a version given as null", { text: registry(live, null) }],
  ];
  for (const [what, source] of specimens) {
    const row = await credentialsRow(source, ["live-api", "other-key"]);
    assert.equal(row.state, STATE.UNANSWERED, `${what}: ${row.detail}`);
    assert.match(row.detail, /^which credentials the registry references is unknown: /, what);
    assert.doesNotMatch(`${row.detail} ${row.fix ?? ""}`, /aify-env credential|orphan|references: /, `${what}: no command, no orphan`);
  }
  // The control: the same live registry with the supported version reads, and the confounder is a real orphan.
  const known = await credentialsRow(registry(live), ["live-api", "other-key"]);
  assert.match(known.detail, /no registry entry references: other-key$/);
});

test("an absent or empty registry is known-empty, so its orphans are real", async () => {
  for (const source of [{ missing: true }, { text: "" }]) {
    const row = await credentialsRow(source, ["stray"]);
    assert.match(row.detail, /no registry entry references: stray$/, JSON.stringify(source));
    assert.deepEqual(commandsIn(row.fix).map((c) => [c.action, c.ref]), [["remove", "stray"]]);
  }
});

test("AN ENTRY WITH NO ENDPOINT still references its credential, so its stored key is not an orphan", async () => {
  // The bug: the referenced set came from readServices, which drops an entry with no endpoint before probing.
  const row = await credentialsRow(JSON.stringify({ version: 1, services: { "aify-dashboard": { credentialRef: "live-api" } } }), ["live-api"]);
  assert.equal(row.state, STATE.PASSED, row.detail);
});

test("COMMANDS for literal identities: a space, a leading dash, a path, quotes and dollars; and one that cannot be printed", async () => {
  // Each must resolve to exactly the identity the registry holds, with nothing normalised.
  const services = ["demo service", "-lead", "/review-literal", "C:/x", "//share/x", 'q"$\\x', "it's"];
  const entries = Object.fromEntries(services.map((name, i) => [name, { secretsCredentialRef: i === 1 ? "--fetch-key" : `key-${i}` }]));
  const row = await credentialsRow(registry(entries), []);
  const commands = commandsIn(row.fix);
  assert.deepEqual(commands.map((c) => [c.action, c.problem, c.service, c.ref]).sort(),
    services.map((name, i) => ["set", "", name, i === 1 ? "--fetch-key" : `key-${i}`]).sort());
  assert.deepEqual(commands.filter((c) => !c.actionable).map((c) => c.service), ["it's"], "only the single quote is not actionable");
  // And an orphan whose name begins with dashes.
  const orphan = await credentialsRow(registry({ s: { credentialRef: "live" } }), ["live", "--orphan-key"]);
  assert.deepEqual(commandsIn(orphan.fix).map((c) => [c.action, c.problem, c.ref]), [["remove", "", "--orphan-key"]]);
});

test("THE CLI: exact refs and services in the = form; a given value that is empty, malformed or missing is refused", () => {
  const ok = (argv) => { const options = parseCredentialArgs(argv); assert.equal(options.problem, "", JSON.stringify(argv)); return options; };
  assert.equal(referenceFor(ok(["remove", "--ref", "dashboard-secrets"])), "dashboard-secrets");
  assert.equal(referenceFor(ok(["remove", "--ref=--fetch-key"])), "--fetch-key");
  assert.equal(referenceFor(ok(["remove", "--ref=--stdin"])), "--stdin", "in the = form a dashed value is a value");
  assert.equal(ok(["set", "--service=-lead", "--ref=x", "--stdin"]).service, "-lead");
  assert.equal(ok(["set", "--service=demo service", "--ref=x", "--stdin"]).service, "demo service");
  for (const argv of [["remove", "--ref", ""], ["remove", "--ref"], ["remove", "--service", "aify-dashboard", "--ref", ""],
    ["remove", "--ref", "../outside"], ["remove", "--ref", "--stdin"], ["remove"], ["remove", "--ref="], ["set", "--service=", "--ref=x", "--stdin"], ["remove", "--service=", "--ref=x"]]) {
    assert.notEqual(parseCredentialArgs(argv).problem, "", JSON.stringify(argv));
  }
  // Unchanged: the service default for remove, and set needing --service and --stdin.
  assert.equal(referenceFor(ok(["remove", "--service", "aify-dashboard"])), defaultCredentialRef("aify-dashboard"));
  assert.notEqual(parseCredentialArgs(["set", "--ref", "x", "--stdin"]).problem, "");
  assert.notEqual(parseCredentialArgs(["set", "--service", "s", "--ref", "x"]).problem, "");
});

test("an unreadable store leaves the row unanswered", async () => {
  assert.equal((await credentialsRow(registry({ "aify-dashboard": { credentialRef: "x" } }), null, { storeProblem: "EACCES" })).state, STATE.UNANSWERED);
});

test("registryReferences: the whole reference population, known-empty, or UNKNOWN, read as the registry holds it", () => {
  const text = JSON.stringify({ services: { bare: { credentialRef: "a" }, full: { endpoint: "http://x", secretsCredentialRef: "b", note: "c" }, odd: 5 } });
  assert.deepEqual(registryReferences({ text }), { references: [
    { service: "bare", field: "credentialRef", ref: "a" }, { service: "full", field: "secretsCredentialRef", ref: "b" }] }, "no version: read on its merits");
  assert.deepEqual(registryReferences({ missing: true }), { references: [] });
  assert.deepEqual(registryReferences({ text: "  " }), { references: [] });
  for (const source of [{ readError: "EACCES" }, { text: "[]" }, { text: JSON.stringify({ version: "1", services: {} }) }]) {
    assert.match(registryReferences(source).unknown, /./, JSON.stringify(source));
  }
});
