#!/usr/bin/env node
/**
 * `aify-env agents` -- this host's agent definitions, read and changed through DefinitionStore.
 *
 * OFFLINE BY DESIGN: every verb works with no service reachable. The store is the only writer of
 * ~/.aify/agent-definitions; this command is one of its callers and writes nothing itself.
 */

import process from "node:process";

import { installedHarnesses } from "../lib/advertise.mjs";
import { DefinitionRefused, DefinitionStore, DefinitionStoreError } from "../lib/agent-definitions.mjs";
import { aifyLauncherFilesOnPath } from "../lib/launcher-scan.mjs";

const EOL = String.fromCharCode(10);
export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_FAILED = 65;

const USAGE = [
  "usage:",
  "  aify-env agents list",
  "  aify-env agents show <id>",
  "  aify-env agents set <id> key=value ...     keys: name role harness mode workspace model effort",
  "                                               instructions herdrSpace env.<NAME>; -env.<NAME> unsets",
  "  aify-env agents remove <id>",
  "  aify-env agents unlock                      remove the lock of a store writer that is no longer running",
  "  aify-env agents recover --as-committed | --as-not-committed",
  "                                               settle a recovery conflict the store could not prove",
].join(EOL);

//: What a new definition starts with when `set` does not say. Everything else must be given.
const NEW_DEFINITION = Object.freeze({ model: "", effort: "", instructions: "", env: {}, herdrSpace: true });
const TEXT_KEYS = new Set(["name", "role", "harness", "mode", "workspace", "model", "effort", "instructions"]);

/**
 * Parse argv into an intent. PURE, so the rules are testable without a store.
 * @returns {{verb: string, id?: string, changes?: Array, choice?: string, problem: string}}
 */
export function parseAgentsArgs(argv) {
  const [verb = "", ...rest] = Array.isArray(argv) ? argv.map(String) : [];
  const fail = (problem) => ({ verb, problem });
  if (verb === "list" || verb === "unlock") return rest.length ? fail(`${verb} takes no arguments`) : { verb, problem: "" };
  if (verb === "recover") {
    const choice = { "--as-committed": "committed", "--as-not-committed": "not-committed" }[rest[0]];
    return rest.length === 1 && choice ? { verb, choice, problem: "" } : fail("recover needs --as-committed or --as-not-committed");
  }
  if (verb === "show" || verb === "remove") return rest.length === 1 ? { verb, id: rest[0], problem: "" } : fail(`${verb} needs exactly one id`);
  if (verb !== "set") return fail(verb ? `unknown verb '${verb}'` : "no verb given");
  const [id, ...pairs] = rest;
  if (!id) return fail("set needs an id");
  if (pairs.length === 0) return fail("set needs at least one key=value");
  const changes = [];
  for (const pair of pairs) {
    if (pair.startsWith("-env.")) { changes.push({ unsetEnv: pair.slice("-env.".length) }); continue; }
    const at = pair.indexOf("=");
    if (at < 1) return fail(`'${pair}' is not key=value`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (key.startsWith("env.")) changes.push({ env: key.slice("env.".length), value });
    else if (key === "herdrSpace") {
      if (value !== "true" && value !== "false") return fail("herdrSpace is true or false");
      changes.push({ key, value: value === "true" });
    } else if (TEXT_KEYS.has(key)) changes.push({ key, value });
    else return fail(`unknown key '${key}'`);
  }
  return { verb, id, changes, problem: "" };
}

/** The agent `set` writes: the current definition (or a new one's defaults) with the changes applied. */
export function applyChanges(current, changes) {
  const agent = { ...NEW_DEFINITION, ...(current ?? {}), env: { ...(current?.env ?? NEW_DEFINITION.env) } };
  delete agent.id;
  for (const change of changes) {
    if (change.unsetEnv !== undefined) delete agent.env[change.unsetEnv];
    else if (change.env !== undefined) agent.env[change.env] = change.value;
    else agent[change.key] = change.value;
  }
  return agent;
}

function describe(entry) {
  if (entry.problems?.length) return `${entry.id}  INVALID  ${entry.problems.join("; ")}`;
  const a = entry.agent;
  return `${entry.id}  ${a.harness}/${a.mode}  incarnation ${entry.incarnation} revision ${entry.revision}  ${a.workspace}`;
}

function conflictLines(conflict) {
  return [
    "RECOVERY CONFLICT: the store could not prove whether an interrupted operation ran.",
    `  operation ${conflict.intent?.operation} (${conflict.intent?.op} ${conflict.intent?.id ?? ""})`,
    `  before: ${conflict.before ?? "?"}   now: ${conflict.current?.present ? conflict.current.digest : "absent"}`,
    "  Nothing is written or published until you settle it: aify-env agents recover --as-committed | --as-not-committed",
  ];
}

/** Run one parsed intent against a store. Returns the lines to print and the exit code. */
export async function runAgents(intent, { store, installed, dir }) {
  if (intent.verb === "unlock") {
    const removed = DefinitionStore.unlock({ dir });
    return { code: EXIT_OK, lines: [removed ? `removed the lock left by process ${removed.pid ?? "unknown"}, which is not running` : "the store is not locked"] };
  }
  if (intent.verb === "recover") {
    const settled = await store.settleConflict(intent.choice);
    return { code: EXIT_OK, lines: [`operation ${settled.settled} settled as ${settled.outcome}`] };
  }
  if (intent.verb === "list" || intent.verb === "show") {
    const listed = await store.list();
    const lines = [];
    if (listed.conflict) lines.push(...conflictLines(listed.conflict));
    for (const settled of listed.recovered) lines.push(`recovered an interrupted ${settled.op} of ${settled.id}: ${settled.outcome}`);
    if (listed.unreadable.length) lines.push(`could not read: ${listed.unreadable.join(", ")}`);
    if (intent.verb === "list") {
      lines.push(...(listed.definitions.length ? listed.definitions.map(describe) : ["no agents are defined on this host"]));
      return { code: EXIT_OK, lines };
    }
    const entry = listed.definitions.find((d) => d.id === intent.id);
    if (!entry) return { code: EXIT_FAILED, lines: [...lines, `${intent.id} is not defined`] };
    return { code: EXIT_OK, lines: [...lines, JSON.stringify(entry, null, 2)] };
  }
  if (intent.verb === "set") {
    const { definitions } = await store.list();
    const current = definitions.find((d) => d.id === intent.id && !d.problems.length);
    const result = await store.set(intent.id, applyChanges(current?.agent, intent.changes), { installed });
    return { code: EXIT_OK, lines: [`${result.id}: incarnation ${result.incarnation} revision ${result.revision}`] };
  }
  const removed = await store.remove(intent.id);
  return { code: EXIT_OK, lines: [`${removed.id} removed to .trash/${removed.trashName}`] };
}

async function main() {
  const intent = parseAgentsArgs(process.argv.slice(2));
  if (intent.problem) {
    process.stderr.write(`aify-env agents: ${intent.problem}${EOL}${USAGE}${EOL}`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const store = new DefinitionStore();
  const installed = new Set(installedHarnesses(aifyLauncherFilesOnPath()).map((h) => h.client));
  try {
    const { code, lines } = await runAgents(intent, { store, installed, dir: store.dir });
    process.stdout.write(lines.join(EOL) + EOL);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof DefinitionRefused || error instanceof DefinitionStoreError)) throw error;
    const detail = error.problems?.length ? ` (${error.problems.join("; ")})` : "";
    process.stderr.write(`aify-env agents: ${error.message}${detail}${EOL}`);
    if (error.conflict) process.stderr.write(conflictLines(error.conflict).join(EOL) + EOL);
    process.exitCode = EXIT_FAILED;
  }
}

// Run only as a command: tests import the parsing and `runAgents` without touching the operator's store.
if (process.argv[1] && /aify-env-agents\.mjs$/.test(process.argv[1])) await main();
