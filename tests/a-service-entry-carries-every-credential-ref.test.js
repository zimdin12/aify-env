#!/usr/bin/env node
// A registry entry may name more than one stored credential: `credentialRef` for the service's API key, and
// `secretsCredentialRef` for aify-dashboard's secrets fetch key (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, E,
// and D3 of its review: the referenced set derives from every `*CredentialRef` field, never a list naming two).

import assert from "node:assert/strict";
import test from "node:test";

import { isCredentialRefField } from "../lib/credential-store.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { pluginCredential } from "../lib/plugin-bootstrap.mjs";
import { readServices } from "../lib/services.mjs";
import { STATE } from "../lib/health.mjs";

const registry = (entry) => JSON.stringify({ version: 1, services: { "aify-dashboard": { endpoint: "http://127.0.0.2:1", ...entry } } });

test("an entry's every valid *CredentialRef field is carried by field, and nothing else is", () => {
  // The bug: the second reference never reaches the plugin, or a malformed one is carried and becomes a path tried.
  const [entry] = readServices(registry({ credentialRef: "aify-dashboard", secretsCredentialRef: "dashboard-secrets",
    laterCredentialRef: "later", brokenCredentialRef: "../outside", credentialRefs: "not-a-field", notACredential: "x" }));
  assert.deepEqual(entry.credentialRefs,
    { credentialRef: "aify-dashboard", secretsCredentialRef: "dashboard-secrets", laterCredentialRef: "later" });
  assert.equal(entry.credentialRef, "aify-dashboard", "the API key's reference is read as before");
  assert.deepEqual(readServices(registry({})).at(0).credentialRefs, {});
  // The shape, by field name alone: near misses are not credential references.
  assert.deepEqual(["credentialRef", "secretsCredentialRef", "a1CredentialRef"].filter(isCredentialRefField).length, 3);
  assert.deepEqual(["CredentialRef", "credentialRefs", "secretscredentialref", "SecretsCredentialRef", "xCredentialRefY", "_CredentialRef"]
    .filter(isCredentialRefField), []);
});

test("THE DOCTOR counts a secrets reference: its file is no orphan, and a missing one is dangling", async () => {
  // The bug: the live secrets key is reported as a credential nothing references, which invites deleting it; and a
  // reference to a key that is not stored goes unreported until a start is refused.
  const credentials = async (text, names) => {
    const checks = await collectEnvironmentChecks({
      endpoint: "http://example.invalid", knock: async () => ({ ok: false, error: "down" }),
      readRegistry: () => ({ text }), terminalSupport: () => ({ available: true }),
      readCredentialStore: async () => ({ names }),
    });
    return checks.find((check) => check.id === "credentials");
  };
  const both = registry({ credentialRef: "aify-dashboard", secretsCredentialRef: "dashboard-secrets" });
  const held = await credentials(both, ["aify-dashboard", "dashboard-secrets"]);
  assert.equal(held.state, STATE.PASSED, held.detail);
  const missing = await credentials(both, ["aify-dashboard"]);
  assert.equal(missing.state, STATE.FAILED);
  assert.match(missing.detail, /1 registry reference\(s\) name a credential that is not stored: dashboard-secrets$/);
  // The control: an unreferenced file is still an orphan.
  const orphaned = await credentials(registry({ credentialRef: "aify-dashboard" }), ["aify-dashboard", "dashboard-secrets"]);
  assert.match(orphaned.detail, /no registry entry references: dashboard-secrets$/);
});

test("a plugin asking for a named credential gets that reference's key, and never the API key in its place", async () => {
  // The bug (design test 6): credentials swapped, so the fleet-wide API key is presented to the secrets route, or the
  // fetch key to everything. A named credential has no environment override and no fallback: absent is "".
  const asked = [];
  const resolve = async (target) => { asked.push(target); return { state: "ok", value: `key-for-${target.credentialRef || "env"}` }; };
  const [entry] = readServices(registry({ keyEnv: ["AIFY_DASHBOARD_KEY"], credentialRef: "aify-dashboard", secretsCredentialRef: "dashboard-secrets" }));
  assert.equal(await pluginCredential(entry, resolve), "key-for-aify-dashboard");
  assert.equal(await pluginCredential(entry, resolve, "secretsCredentialRef"), "key-for-dashboard-secrets");
  assert.deepEqual(asked.at(-1).keyEnv, [], "no environment variable stands in for a named credential");
  const [apiOnly] = readServices(registry({ keyEnv: ["AIFY_DASHBOARD_KEY"], credentialRef: "aify-dashboard" }));
  const before = asked.length;
  assert.equal(await pluginCredential(apiOnly, resolve, "secretsCredentialRef"), "");
  assert.equal(asked.length, before, "nothing is resolved for a reference the entry does not hold");
});
