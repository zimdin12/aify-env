// The doctor's auto-confirm and claude-trust-roots rows (lib/plugins/aify-comms/auto-confirm-checks.mjs).
//
// claude-trust-roots models claude's own rule as measured on 2.1.312 (2026-10-28): a folder is trusted when it or an
// ancestor has `hasTrustDialogAccepted: true`. So the cases that matter are an ancestor's trust counting, a folder's
// own `false` not overriding it, and a sibling that merely shares a prefix not counting.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fromVerdict } from "../lib/health.mjs";
import { autoConfirmVerdict, claudeTrustRootsVerdict } from "../lib/plugins/aify-comms/auto-confirm-checks.mjs";

const claude = (projects) => JSON.stringify({ projects });
const row = (verdict) => fromVerdict("x", verdict);

test("auto-confirm: the defaults, a written value, and a mistake each say what is in force", () => {
  const absent = autoConfirmVerdict({ config: null, problem: "", absent: true });
  assert.deepEqual([row(absent).state, absent.code, absent.detail], ["passed", "default", "folderTrust on (nothing written, so the defaults)"]);
  const off = autoConfirmVerdict({ config: { autoConfirm: { folderTrust: false } }, problem: "" });
  assert.deepEqual([row(off).state, off.code, off.detail], ["passed", "configured", "folderTrust off"]);
  const typo = autoConfirmVerdict({ config: { autoConfirm: { folderTrus: false } }, problem: "" });
  assert.equal(row(typo).state, "failed");
  assert.match(typo.detail, /^folderTrust on: autoConfirm\.folderTrus is not an answer this host gives/);
  const broken = autoConfirmVerdict({ config: null, problem: "~/.aify/config.json is not JSON" });
  assert.equal(row(broken).state, "failed");
  assert.match(broken.detail, /^folderTrust off: ~\/\.aify\/config\.json is not JSON/);
});

test("claude-trust-roots: an ancestor's trust covers a root, and the root's own false does not undo it", () => {
  const verdict = claudeTrustRootsVerdict({ roots: ["C:\\Users\\Op\\projects\\app"], folderTrustOn: false, windows: true,
    claudeConfig: claude({ "c:/users/op/projects": { hasTrustDialogAccepted: true }, "C:/Users/Op/projects/app": { hasTrustDialogAccepted: false } }) });
  assert.deepEqual([row(verdict).state, verdict.code], ["passed", "trusted"]);
});

test("claude-trust-roots: a sibling sharing a prefix does not count, and with the answer off that fails with a fix", () => {
  const verdict = claudeTrustRootsVerdict({ roots: ["C:/work"], folderTrustOn: false, windows: true,
    claudeConfig: claude({ "C:/work2": { hasTrustDialogAccepted: true }, "C:/work/sub": { hasTrustDialogAccepted: true } }) });
  assert.deepEqual([row(verdict).state, verdict.code], ["failed", "untrusted"]);
  assert.match(verdict.fix, /^open claude once in C:\/work and choose "Yes, I trust this folder"/);
  // And the other way round: a trusted C:/work is not an ancestor of C:/work2, though it is a prefix of it.
  assert.equal(claudeTrustRootsVerdict({ roots: ["C:/work2"], folderTrustOn: false, windows: true,
    claudeConfig: claude({ "C:/work": { hasTrustDialogAccepted: true } }) }).code, "untrusted");
});

test("claude-trust-roots: the fix for a drive root says it trusts the whole drive", () => {
  for (const root of ["C:\\", "C:/", "c:", "/"]) {
    const verdict = claudeTrustRootsVerdict({ roots: [root], folderTrustOn: false, windows: true, claudeConfig: claude({}) });
    assert.match(verdict.fix, /which trusts the WHOLE DRIVE/, root);
  }
  const folder = claudeTrustRootsVerdict({ roots: ["C:/work"], folderTrustOn: false, windows: true, claudeConfig: claude({}) });
  assert.match(folder.fix, /which covers every folder below it/);
});

test("claude-trust-roots: with the answer on, an untrusted root passes and says the dialog is answered", () => {
  const verdict = claudeTrustRootsVerdict({ roots: ["C:/work"], folderTrustOn: true, windows: true, claudeConfig: claude({}) });
  assert.deepEqual([row(verdict).state, verdict.code], ["passed", "answered"]);
});

test("claude-trust-roots: case is folded on Windows only", () => {
  const config = claude({ "/Home/op": { hasTrustDialogAccepted: true } });
  assert.equal(claudeTrustRootsVerdict({ roots: ["/home/op/app"], folderTrustOn: false, windows: false, claudeConfig: config }).code, "untrusted");
  assert.equal(claudeTrustRootsVerdict({ roots: ["/home/op/app"], folderTrustOn: false, windows: true, claudeConfig: config }).code, "trusted");
});

test("claude-trust-roots: unknown roots or an unreadable claude config is UNANSWERED, never passed", () => {
  for (const facts of [
    { roots: null, claudeConfig: claude({}) },
    { roots: [], claudeConfig: claude({}) },
    { roots: ["C:/w"], claudeConfig: null },
    { roots: ["C:/w"], claudeConfig: "{ not json" },
    { roots: ["C:/w"], claudeConfig: "{}" },
  ]) {
    assert.equal(row(claudeTrustRootsVerdict({ ...facts, folderTrustOn: true, windows: true })).state, "unanswered", JSON.stringify(facts));
  }
});
