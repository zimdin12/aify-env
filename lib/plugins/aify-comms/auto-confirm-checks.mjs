// Two doctor rows for the dialogs this plugin answers (screen-answers.mjs):
//
//   auto-confirm        what plugins["aify-comms"].autoConfirm turns on, and anything wrong with how it is written
//   claude-trust-roots  whether claude already trusts each folder this host runs work in
//
// WHY THE SECOND ONE. Claude trusts a folder when the folder or one of its ancestors is trusted: measured on claude
// 2.1.312 (2026-10-28), a new folder whose own entry said false started with no dialog because an ancestor was
// trusted, and one with no trusted ancestor showed it. So a root this host runs work in, trusted once by the operator,
// means no managed worker below it ever meets the dialog -- the one manual step a fresh machine needs when the answer
// is switched off. With it on, an untrusted root is said and passes: the dialog is answered.
//
// READ-ONLY. ~/.claude.json is read for `projects[<folder>].hasTrustDialogAccepted` and nothing else, at the path
// claude-login-check.mjs also reads claude's files under (the home directory). Nothing here writes it: about twenty
// running claude processes rewrite that file, and a write from outside them is one lost update from vanishing.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { autoConfirmSettings } from "./screen-answers.mjs";

/** PURE. The auto-confirm row's verdict from this plugin's config read. */
export function autoConfirmVerdict(read) {
  const { on, problems } = autoConfirmSettings(read);
  const values = Object.entries(on).map(([key, value]) => `${key} ${value ? "on" : "off"}`).join(", ");
  if (problems.length) {
    return { ok: false, code: "config-problem", detail: `${values}: ${problems.join("; ")}`,
      fix: 'write plugins["aify-comms"].autoConfirm in ~/.aify/config.json as an object of true/false values, e.g. {"folderTrust": true}' };
  }
  return { ok: true, code: read?.absent ? "default" : "configured", detail: `${values}${read?.absent ? " (nothing written, so the defaults)" : ""}` };
}

/** A folder as claude keys it, compared without trailing slashes, and without case on Windows. */
function folderKey(folder, windows) {
  const forward = String(folder ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  return windows ? forward.toLowerCase() : forward;
}

/** The folder and each of its ancestors, nearest first. */
function selfAndAncestors(key) {
  const out = [key];
  for (let at = key.lastIndexOf("/"); at > 0; at = key.lastIndexOf("/", at - 1)) out.push(key.slice(0, at));
  return out;
}

/**
 * PURE. The claude-trust-roots row's verdict.
 *
 * @param {object} facts
 * @param {string[]|null} facts.roots  the running daemon's cwdRoots, null when no daemon answered
 * @param {string|null} facts.claudeConfig  the text of ~/.claude.json, null when it could not be read
 * @param {boolean} facts.folderTrustOn  whether this host answers the dialog
 */
export function claudeTrustRootsVerdict({ roots, claudeConfig, folderTrustOn, windows = process.platform === "win32" }) {
  if (!Array.isArray(roots) || !roots.length) {
    return { ok: false, code: "unknown-roots", detail: "no aify-env said which folders it runs work in, so their trust is unknown" };
  }
  let projects;
  try {
    projects = JSON.parse(claudeConfig ?? "").projects;
  } catch {
    projects = undefined;
  }
  if (!projects || typeof projects !== "object") {
    return { ok: false, code: "unknown-claude-config", detail: "~/.claude.json could not be read as claude's config, so which folders it trusts is unknown" };
  }
  const trusted = new Set(Object.entries(projects)
    .filter(([, entry]) => entry?.hasTrustDialogAccepted === true).map(([folder]) => folderKey(folder, windows)));
  const untrusted = roots.filter((root) => !selfAndAncestors(folderKey(root, windows)).some((key) => trusted.has(key)));
  if (!untrusted.length) return { ok: true, code: "trusted", detail: `claude trusts ${roots.join(", ")}, so no managed worker below it meets the dialog` };
  const named = untrusted.join(", ");
  if (folderTrustOn) {
    return { ok: true, code: "answered", detail: `claude does not trust ${named}; this host answers its trust dialog for managed workers (autoConfirm.folderTrust on)` };
  }
  return { ok: false, code: "untrusted", detail: `claude does not trust ${named}, and autoConfirm.folderTrust is off: each managed claude's first start in a new folder below it waits at the trust dialog`,
    fix: `open claude once in ${untrusted[0]} and choose "Yes, I trust this folder" (it covers every folder below), or turn plugins["aify-comms"].autoConfirm.folderTrust on` };
}

/** Both rows, read from disk unless a test hands the reads in. */
export function checkAutoConfirm({ add, roots, config, readClaudeConfig = () => readFileSync(join(homedir(), ".claude.json"), "utf8"), windows }) {
  const read = typeof config === "function" ? config() : null;
  const settings = autoConfirmVerdict(read);
  add("auto-confirm", settings.ok, settings.code, settings.detail, settings.fix);
  let claudeConfig = null;
  try { claudeConfig = readClaudeConfig(); } catch { claudeConfig = null; }
  const trust = claudeTrustRootsVerdict({ roots, claudeConfig, folderTrustOn: autoConfirmSettings(read).on.folderTrust, windows });
  add("claude-trust-roots", trust.ok, trust.code, trust.detail, trust.fix);
}
