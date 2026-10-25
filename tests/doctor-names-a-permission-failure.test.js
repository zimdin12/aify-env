// A non-root fresh install read its definition store as EACCES (the store directory was 0600), and the
// doctor told the operator to check the machine identity (fresh-install report, 2026-10-25). A permission
// error in the reported problem now names the permissions; any other problem keeps its own advice.
import assert from "node:assert/strict";
import test from "node:test";

import { definitionsCheck } from "../lib/definition-checks.mjs";
import { pickerReadinessCheck } from "../lib/environment-checks.mjs";
import { permissionAwareFix } from "../lib/health.mjs";

const EACCES = "EACCES: permission denied, open '/home/u/.aify/agent-definitions/.lock'";
const picker = (problem) => pickerReadinessCheck({ ok: true, status: 200, body: { agents: [], problem } });
const sync = (lastPushError) => definitionsCheck({ answered: true, plugins: [{ name: "aify-comms",
  state: { definitions: { accepted: true, lastPushError, lastRequestError: "", published: null } } }] });

test("a permission error in the picker's problem points at permissions, not the machine identity", () => {
  assert.match(picker(EACCES).fix, /permission/);
  assert.doesNotMatch(picker(EACCES).fix, /machine identity/);
  assert.match(picker("EPERM: operation not permitted, mkdir 'x'").fix, /permission/);
});

test("permissionAwareFix matches the error code as a word, and keeps the fallback otherwise", () => {
  assert.match(permissionAwareFix(EACCES, "fallback"), /permissions/);
  assert.equal(permissionAwareFix("XEACCESX: a name that contains it", "fallback"), "fallback");
  assert.equal(permissionAwareFix(undefined, "fallback"), "fallback");
});

test("CONTROL: any other picker problem keeps the identity advice", () => {
  assert.match(picker("machine id unknown").fix, /machine identity/);
});

test("a permission error behind an unpublished definitions push points at permissions too", () => {
  assert.match(sync(EACCES).fix, /permission/);
  assert.doesNotMatch(sync("0: down").fix, /permission/);
});
