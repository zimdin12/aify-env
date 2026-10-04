#!/usr/bin/env node
// The doctor's credentials row says which stored credential is missing or unreferenced, what it is for, and the exact
// command that targets it (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, "The doctor's credential advice: plan
// approved with named changes").
//
// THE COMMANDS ARE CHECKED BY THE CONSUMER. Each printed command is parsed by the real `parseCredentialArgs` and
// resolved by the real `referenceFor`, which is what `aify-env credential` would act on. Nothing is set or removed.

import assert from "node:assert/strict";
import test from "node:test";

import { parseCredentialArgs, referenceFor } from "../bin/aify-env-credential.mjs";
import { defaultCredentialRef } from "../lib/credential-store.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";

const registry = (services, version = 1) => JSON.stringify({ version, services: Object.fromEntries(Object.entries(services)
  .map(([name, entry]) => [name, { endpoint: `http://127.0.0.2/${name}`, ...entry }])) });

async function credentialsRow(text, names, { storeProblem = "" } = {}) {
  const checks = await collectEnvironmentChecks({
    endpoint: "http://example.invalid", knock: async () => ({ ok: false, error: "down" }),
    readRegistry: () => ({ text }), terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => (storeProblem ? { problem: storeProblem } : { names }),
  });
  return checks.find((check) => check.id === "credentials");
}

/** Every `aify-env credential ...` command in a fix, as what the real CLI would act on. */
function commandsIn(fix) {
  return [...String(fix).matchAll(/aify-env credential ((?:set|remove)[^`\n]*?)(?=`|$|\n| \()/g)].map((match) => {
    const argv = match[1].trim().split(/\s+/);
    const options = parseCredentialArgs(argv);
    return { text: match[0], action: options.action, problem: options.problem, service: options.service, ref: referenceFor(options) };
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
  assert.match(row.fix, /later, named by aify-dashboard's laterCredentialRef\. Store it with/);
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
  // A case variant of a stored file is neither missing nor an orphan.
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

test("an unreadable registry or store leaves the row unanswered", async () => {
  assert.equal((await credentialsRow(registry({ "aify-dashboard": { credentialRef: "x" } }, 99), ["x"])).state, STATE.UNANSWERED);
  assert.equal((await credentialsRow(registry({ "aify-dashboard": { credentialRef: "x" } }), null, { storeProblem: "EACCES" })).state, STATE.UNANSWERED);
});

test("THE CLI: remove takes an exact --ref alone; a given --ref that is empty, malformed or missing is refused", () => {
  // The bug class: an empty --ref fell through to the service's default, so `--service s --ref ""` targeted the live key.
  const ok = parseCredentialArgs(["remove", "--ref", "dashboard-secrets"]);
  assert.deepEqual([ok.problem, referenceFor(ok)], ["", "dashboard-secrets"]);
  for (const argv of [["remove", "--ref", ""], ["remove", "--ref"], ["remove", "--service", "aify-dashboard", "--ref", ""],
    ["remove", "--ref", "../outside"], ["remove", "--ref", "--stdin"], ["remove"]]) {
    assert.notEqual(parseCredentialArgs(argv).problem, "", JSON.stringify(argv));
  }
  // Unchanged: the service default for remove, and set needing --service and --stdin.
  const byService = parseCredentialArgs(["remove", "--service", "aify-dashboard"]);
  assert.deepEqual([byService.problem, referenceFor(byService)], ["", defaultCredentialRef("aify-dashboard")]);
  assert.notEqual(parseCredentialArgs(["set", "--ref", "x", "--stdin"]).problem, "");
  assert.notEqual(parseCredentialArgs(["set", "--service", "s", "--ref", "x"]).problem, "");
});
