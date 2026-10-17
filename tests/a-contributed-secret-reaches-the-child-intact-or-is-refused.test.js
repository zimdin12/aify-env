#!/usr/bin/env node
// A contributed secret reaches the child exactly as fetched, or the start is refused before any child exists
// (comms-senior-dev's R1 on f219ae1). The host's start path removes or rewrites some names after admission: Runner
// drops the inherited pane identity (runner.mjs `withoutPaneIdentity`), and on Windows a bash launcher's PATH gets the
// toolchain prefixed (shell-toolchain.mjs `withToolchainOnPath`). A secret under one of those names would start a worker
// without the value its definition requires.
//
// Driven through route A with main's admission and a REAL Runner, whose two child seams (`openTerminal`, `spawnProcess`)
// are the fakes: what they are handed is what the child would get. A capture of the spec before Runner cannot see this.
// The names are written out here, from what those two functions do, not imported from them: a list read from the code
// under test can only agree with it.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { LifecycleJournal } from "../lib/agent-lifecycle.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { automaticStartAdmission } from "../lib/plugins/aify-comms/automatic-start-admission.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { Runner } from "../lib/runner.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";
import { toolchainDirsFor } from "../lib/shell-toolchain.mjs";
import { buildStartSpec } from "../lib/start-spec.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const WINDOWS = process.platform === "win32";
const LAUNCHER_TEXT = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join("\n");
const VALUE = "required-value-7f3a91c2";
const REMOVED = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];
const REFUSED = (name) => `${name} is one this host removes or rewrites before a worker starts, so its value would not arrive as fetched`;
const slashed = (p) => p.split(path.sep).join("/");

/** A spec the way the comms plugin builds one, for a launcher that needs no interpreter. */
const directSpec = ({ launcher, args, cwd, env, label }) => ({ spec: { service: "aify-comms", launcher, command: launcher, args, cwd, env, label, fileText: LAUNCHER_TEXT } });
/** The production builder, on Windows, with the toolchain's directories present: the PATH rule is live. */
const windowsBashSpec = (request) => buildStartSpec({ ...request, service: "aify-comms" },
  { readFile: () => LAUNCHER_TEXT, platform: "win32", dirExists: () => true });

/**
 * One defined start through route A, whose definition names `name` and whose contributor answers `value` for it, on a
 * real Runner whose `branch` seam ("terminal" or "piped") records what the child is handed.
 */
async function start({ name, value = VALUE, branch = "terminal", buildSpec = directSpec }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-child-env-"));
  const store = new DefinitionStore({ dir: path.join(root, "definitions"), lockWaitMs: 300 });
  await store.set("lead", { name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: slashed(root), model: "",
    effort: "", instructions: "", env: {}, herdrSpace: false, secrets: { project: "p1", names: [name] } }, { installed: ALL });
  const { storeId } = await store.list();
  const aifyHome = path.join(root, "aify-home");
  fs.mkdirSync(aifyHome);
  new LifecycleJournal({ file: path.join(aifyHome, "agent-lifecycle.json") }).initialize({ priorBoot: false });

  let current = null;
  const identity = () => ({ current, conflict: false, unknown: false });
  const children = [];
  const openTerminal = (command, args, options) => {
    children.push({ command, args, env: options.env });
    return { pid: 4242, cols: 80, rows: 24, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {}, resize: () => {} };
  };
  const spawnProcess = (command, args, options) => {
    children.push({ command, args, env: options.env });
    const child = new EventEmitter();
    Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} }, kill() {} });
    return child;
  };
  const runner = new Runner({ ownedFile: path.join(root, "env-processes.json"), openTerminal: branch === "terminal" ? openTerminal : null,
    spawnProcess, loadCheckpoint: async () => null,
    managedHost: () => ({ instance: "default", url: "http://127.0.0.1:1",
      host: { startManaged: (record) => { current = record; }, endManaged: () => ({ problem: "" }) } }) });
  const agents = { ...createAgentLifecyclePorts({ aifyHome, machineId: "m", stateHost: { rawIdentity: identity }, runner, definitions: store }),
    rawIdentity: identity };
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: [slashed(path.join(root, "claude-aify")), "--aify-agent", "lead"],
    cwd: slashed(root), env: {}, definition: { storeId, incarnation: 1, revision: 1 } };
  const reports = [];
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, handles: createHandleBook(),
    api: { async launch() { return { launch }; }, async reportControl(id, patch) { reports.push(patch); }, async terminalOutput() { return {}; } },
    processes: new PluginProcesses(runner), cwdRoots: [slashed(root)], windows: WINDOWS, withinRoots: workspaceWithinRoots,
    buildSpec, resolveCandidates: () => [launch.argv[0]], baseEnv: { KEEP: "inherited" },
    admitStart: automaticStartAdmission({ definitions: store, agents }), definitionFor: (l) => store.boundReading(l),
    spawnEnv: () => [{ service: "aify-dashboard", field: "secrets", async contribute() { return { env: { [name]: value } }; } }],
  });
  for (const { id } of runner.list()) runner.release?.(id);
  return { result, reports, children };
}

/** What happened to `name`: delivered exactly, refused before any child, or how it reached the child otherwise. PURE. */
function outcomeFor(run, name, value = VALUE) {
  if (run.children.length === 0) {
    return run.result.outcome === "refused" ? { refused: run.result.detail } : { neither: `no child, and ${JSON.stringify(run.result)}` };
  }
  const env = run.children[0].env ?? {};
  const same = (key) => (WINDOWS ? key.toUpperCase() === name.toUpperCase() : key === name);
  const got = Object.entries(env).filter(([key]) => same(key)).map(([, v]) => v);
  if (got.length === 1 && got[0] === value) return { delivered: true };
  return { changed: `the child got ${name} ${got.length === 0 ? "absent" : got.length > 1 ? "twice" : "changed"}` };
}

/** Either exact delivery, or the fixed refusal and no child. */
function assertIntactOrRefused(run, name) {
  const seen = outcomeFor(run, name);
  if (seen.delivered) return;
  assert.equal(seen.refused, REFUSED(name), seen.changed ?? seen.neither ?? `refused for another reason: ${seen.refused}`);
  assert.equal(run.children.length, 0, "refused before any child");
  assert.equal(run.reports.at(-1)?.error, REFUSED(name), "and the service is told why");
}

for (const branch of ["terminal", "piped"]) {
  test(`THE POSITIVE CONTROL, ${branch}: an ordinary API-key secret reaches the child exactly as fetched`, async () => {
    const run = await start({ name: "OPENAI_API_KEY", branch });
    assert.deepEqual(outcomeFor(run, "OPENAI_API_KEY"), { delivered: true }, JSON.stringify(run.result));
    assert.equal(run.children[0].env.KEEP, "inherited", "laid over the daemon's env");
  });

  for (const name of REMOVED) {
    test(`A SECRET NAMED ${name}, ${branch}: intact at the child, or refused before it`, async () => {
      // Runner removes this name from every child's env, and the contributed key alone is what makes it clean.
      assertIntactOrRefused(await start({ name, branch }), name);
    });
  }
}

test("A SECRET NAMED PATH, through a Windows bash launcher with the toolchain present: intact at the child, or refused before it", async (t) => {
  // The conditional case: the production builder prefixes the toolchain onto PATH. The rule is checked live first, on
  // the same builder, so a host where it is inert cannot pass this by having nothing to rewrite.
  const probe = windowsBashSpec({ launcher: "C:/x/claude-aify", args: [], cwd: "C:/x", env: { PATH: VALUE } });
  if (!probe.spec || toolchainDirsFor(probe.spec.command, { platform: "win32", exists: () => true }).length === 0) {
    t.skip(`no bash in a toolchain layout on this host's PATH, so the rule cannot be made live: ${JSON.stringify(probe.error ?? probe.spec?.command)}`);
    return;
  }
  assert.notEqual(probe.spec.env.PATH, VALUE, "THE CONFOUNDER: the builder rewrites a PATH it is handed");
  assertIntactOrRefused(await start({ name: "PATH", buildSpec: windowsBashSpec }), "PATH");
});

test("A SECRET NAMED Path ON WINDOWS, where names are one name in any case: intact at the child, or refused before it", { skip: !WINDOWS && "a Windows rule" }, async () => {
  // The builder drops every casing of path and writes PATH, so a secret spelled Path would reach the child rewritten.
  const probe = windowsBashSpec({ launcher: "C:/x/claude-aify", args: [], cwd: "C:/x", env: { Path: VALUE } });
  assert.notEqual(probe.spec?.env?.PATH ?? probe.spec?.env?.Path, VALUE, "THE CONFOUNDER: the builder rewrites a Path it is handed");
  assertIntactOrRefused(await start({ name: "Path", buildSpec: windowsBashSpec }), "Path");
});

test("the outcome reader can say each answer: delivered, refused, absent, changed", () => {
  // Its adverse controls, so a pass above is the reader's verdict and not its blindness.
  const child = (env) => ({ children: [{ env }], result: { outcome: "started" }, reports: [] });
  assert.deepEqual(outcomeFor(child({ K: VALUE }), "K"), { delivered: true });
  assert.deepEqual(outcomeFor(child({}), "K"), { changed: "the child got K absent" });
  assert.deepEqual(outcomeFor(child({ K: `C:/tool;${VALUE}` }), "K"), { changed: "the child got K changed" });
  assert.deepEqual(outcomeFor({ children: [], result: { outcome: "refused", detail: REFUSED("K") }, reports: [] }, "K"), { refused: REFUSED("K") });
  assert.match(outcomeFor({ children: [], result: { outcome: "started" }, reports: [] }, "K").neither, /^no child/);
});
