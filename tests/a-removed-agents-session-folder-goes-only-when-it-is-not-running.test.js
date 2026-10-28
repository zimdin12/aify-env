// An agent's session folder (~/.aify/sessions/<id>/) goes only when the agent has no definition here AND this host
// says no live process; anything unknown keeps it (lib/session-folders.mjs, approved 2026-10-28).
//
// WHY IT EXISTS. The launcher writes each agent's --mcp-config (which can hold keys) and its instructions there, and a
// kill leaves them behind. Removing a definition does not stop its agent, and its claude keeps reading that folder,
// so a delete at removal time would pull it out from under a running agent.
//
// THE THREE EVENTS, each driven through the real class that raises it: a definition removed (DefinitionStore, both
// the command's path and a service request's), an agent's last lifetime ending (AgentStateHost: a managed end, a
// resident's record gone or proved dead), and the daemon's start (a real daemon, which also serves the route the
// command asks after a removal). Temp homes only.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { forgetSessionFolder } from "../lib/client-actions.mjs";
import { bootDaemonAgentState } from "../lib/daemon-agent-state.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { SessionFolders, definedIn, sessionFolderLine, sessionFolderVerdict, sessionsRoot } from "../lib/session-folders.mjs";
import { runAgents } from "../bin/aify-env-agents.mjs";
import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "..", "bin", "aify-env.mjs");
const AGENTS = path.join(HERE, "..", "bin", "aify-env-agents.mjs");
const L1 = "7f3c9e2a-0000-4000-8000-0000000000d1";
const PID = 4242;
const WRITTEN = 1_790_950_000_000_000;
const NOW = WRITTEN + 60_000_000;
const INSTALLED = new Set(["claude"]);
const RUNNING = { current: { lifetime: L1, pid: PID }, conflict: false, unknown: false };
const STOPPED = { current: null, conflict: false, unknown: false };

const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A sessions root holding a folder per name, each with the files the launcher writes. */
function rootWith(t, names) {
  const root = path.join(tempDir(t, "aify-sessions-"), "sessions");
  for (const name of names) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "instructions.txt"), "rules\n");
    fs.writeFileSync(path.join(root, name, "mcp.json"), "{}\n");
  }
  return root;
}
const listing = (ids, more = {}) => ({ definitions: ids.map((id) => ({ id, agent: { id } })), unreadable: [], conflict: null,
  enumerationFailed: null, ...more });
const agent = (id, home) => ({ id, name: id, role: "worker", harness: "claude", mode: "managed", workspace: home, model: "",
  effort: "", instructions: "", env: {}, herdrSpace: false });

test("the rule: a folder goes only with no definition and no live process; unknown keeps it", () => {
  assert.deepEqual(sessionFolderVerdict({ defined: false, identity: STOPPED }), { remove: true, reason: "not-running" });
  assert.deepEqual(sessionFolderVerdict({ defined: false, identity: RUNNING }), { remove: false, reason: "running" });
  assert.deepEqual(sessionFolderVerdict({ defined: true, identity: STOPPED }), { remove: false, reason: "defined" });
  assert.deepEqual(sessionFolderVerdict({ defined: null, identity: STOPPED }), { remove: false, reason: "definitions-unknown" });
  for (const identity of [null, { ...STOPPED, unknown: true }, { ...STOPPED, conflict: true }]) {
    assert.deepEqual(sessionFolderVerdict({ defined: false, identity }), { remove: false, reason: "identity-unknown" });
  }
  assert.equal(definedIn(listing(["a"]), "a"), true);
  assert.equal(definedIn(listing(["a"]), "b"), false);
  assert.equal(definedIn(listing(["a"], { unreadable: ["x.json"] }), "b"), null, "an unreadable file may be its definition");
  assert.equal(definedIn(null, "b"), null);
});

test("forget: running kept, stopped removed, unknown kept, defined kept, and nothing outside an agent's own folder", async (t) => {
  const root = rootWith(t, ["running", "stopped", "unknown", "defined", "_pid-12"]);
  const identities = { running: RUNNING, stopped: STOPPED, unknown: { ...STOPPED, unknown: true }, defined: STOPPED };
  const folders = new SessionFolders({ root, definitions: { list: async () => listing(["defined"]) },
    // Any other name reads as stopped, so only the id rule can keep `_pid-12` and `..`.
    identity: async (id) => identities[id] ?? STOPPED });
  assert.deepEqual(await folders.forget("running"), { agentId: "running", removed: false, reason: "running" });
  assert.deepEqual(await folders.forget("stopped"), { agentId: "stopped", removed: true, reason: "not-running" });
  assert.deepEqual(await folders.forget("unknown"), { agentId: "unknown", removed: false, reason: "identity-unknown" });
  assert.deepEqual(await folders.forget("defined"), { agentId: "defined", removed: false, reason: "defined" });
  assert.deepEqual(fs.readdirSync(root).sort(), ["_pid-12", "defined", "running", "unknown"]);
  for (const name of ["_pid-12", "..", "a/../b", ""]) assert.equal((await folders.forget(name)).removed, false, name);
  assert.ok(fs.existsSync(path.join(root, "_pid-12")), "a folder nobody named is the launcher's to sweep");
  assert.equal((await folders.forget("never-made")).reason, "absent");
});

test("a store or an identity that cannot answer keeps the folder", async (t) => {
  const root = rootWith(t, ["gone"]);
  const throwing = new SessionFolders({ root, definitions: { list: async () => { throw new Error("locked"); } }, identity: async () => STOPPED });
  assert.equal((await throwing.forget("gone")).reason, "definitions-unknown");
  const silent = new SessionFolders({ root, definitions: { list: async () => listing([]) }, identity: async () => { throw new Error("no"); } });
  assert.equal((await silent.forget("gone")).reason, "identity-unknown");
  assert.ok(fs.existsSync(path.join(root, "gone")));
});

test("reconcile asks about every agent's folder, and only folders", async (t) => {
  const root = rootWith(t, ["left", "kept", "_pid-7"]);
  fs.writeFileSync(path.join(root, "stray"), "not a folder");
  const folders = new SessionFolders({ root, definitions: { list: async () => listing(["kept"]) }, identity: async () => STOPPED });
  const results = await folders.reconcile();
  assert.deepEqual(results.map((r) => [r.agentId, r.removed]).sort(), [["kept", false], ["left", true]]);
  assert.deepEqual(fs.readdirSync(root).sort(), ["_pid-7", "kept", "stray"]);
});

test("REMOVED WHILE RUNNING, THEN EXITS: kept at the removal, removed when its managed lifetime ends", async (t) => {
  const home = tempDir(t, "aify-session-managed-");
  const root = rootWith(t, ["worker", "other"]);
  let folders = null;
  const store = new DefinitionStore({ dir: path.join(home, "definitions"), onRemoved: (id) => folders.notice(id) });
  const host = new AgentStateHost({ aifyHome: home, instance: "default", probe: () => new Map(), nowUs: () => NOW,
    population: "managed", onEnded: (id) => folders.notice(id) });
  host.boot();
  folders = new SessionFolders({ root, definitions: store, identity: (id) => host.rawIdentity(id) });
  await store.set("worker", agent("worker", home), { installed: INSTALLED });
  await store.set("other", agent("other", home), { installed: INSTALLED });
  host.startManaged({ agentId: "worker", lifetime: L1, instance: "default", pid: PID, handle: "h1", cwd: null, definition: null });

  await store.remove("worker");
  await settle();
  assert.ok(fs.existsSync(path.join(root, "worker")), "the folder went while its agent still ran");

  host.endManaged(L1);
  await settle();
  assert.ok(!fs.existsSync(path.join(root, "worker")), "the folder stayed after its agent ended");
  assert.ok(fs.existsSync(path.join(root, "other")), "CONTROL: a defined agent's folder stays");
});

test("a service's removal request tells the listener too; a change that removes nothing does not", async (t) => {
  const home = tempDir(t, "aify-session-request-");
  const removed = [];
  const store = new DefinitionStore({ dir: path.join(home, "definitions"), onRemoved: (id) => removed.push(id) });
  await store.set("a", agent("a", home), { installed: INSTALLED });
  await store.set("b", agent("b", home), { installed: INSTALLED });
  const listed = await store.list();
  const pair = (id) => listed.definitions.find((d) => d.id === id);
  const request = (id, patch) => ({ id: `r-${id}`, agentId: id, storeId: listed.storeId, patch,
    expectedIncarnation: pair(id).incarnation, expectedRevision: pair(id).revision });
  assert.equal((await store.applyRequest(request("b", { role: "lead" }), { installed: INSTALLED })).status, "done");
  assert.deepEqual(removed, [], "an edit is not a removal");
  assert.equal((await store.applyRequest(request("a", { remove: true }), { installed: INSTALLED })).status, "done");
  assert.deepEqual(removed, ["a"]);
  await store.remove("b");
  assert.deepEqual(removed, ["a", "b"]);
});

test("a resident's end is seen whether its record goes or is proved dead, and a failed listing ends nobody", (t) => {
  const home = tempDir(t, "aify-session-resident-");
  const dir = path.join(home, "residents");
  fs.mkdirSync(dir);
  const file = path.join(dir, `lead.${L1}.json`);
  const write = () => fs.writeFileSync(file, JSON.stringify({ agentId: "lead", lifetime: L1, instance: "default", harness: "claude",
    pid: PID, launcher: process.execPath, writtenAtUs: WRITTEN }));
  let alive = true;
  const probe = (pids) => new Map(pids.map((pid) => [pid, alive
    ? { alive: true, createdAtUs: WRITTEN - 1, commandLine: `node "${process.execPath}"` } : { alive: false, createdAtUs: null, commandLine: null }]));
  const ended = [];
  const host = new AgentStateHost({ aifyHome: home, instance: "default", probe, nowUs: () => NOW, onEnded: (id) => ended.push(id) });
  write();
  host.boot();
  assert.ok(host.rawIdentity("lead").current, "CONTROL: the resident reads live");
  assert.deepEqual(ended, []);

  fs.rmSync(file); // the launcher's own clean exit
  host.refresh();
  assert.deepEqual(ended, ["lead"]);

  write();
  host.refresh();
  alive = false; // killed: its record stays until this host proves it dead
  host.refresh();
  assert.deepEqual(ended, ["lead", "lead"]);

  alive = true;
  write();
  host.refresh();
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(dir, "a file where the folder was"); // the listing now fails
  host.refresh();
  assert.deepEqual(ended, ["lead", "lead"], "a listing that failed ended an agent");
});

test("the daemon's hosts both report ends: its managed host and its residents' host", async (t) => {
  const aifyHome = path.join(tempDir(t, "aify-session-boot-"), ".aify");
  fs.mkdirSync(path.join(aifyHome, "env"), { recursive: true });
  fs.writeFileSync(path.join(aifyHome, "env", "residents.generation"), "200\n");
  fs.mkdirSync(path.join(aifyHome, "residents"));
  const file = path.join(aifyHome, "residents", `lead.${L1}.json`);
  fs.writeFileSync(file, JSON.stringify({ agentId: "lead", lifetime: L1, instance: "residents", harness: "claude",
    pid: PID, launcher: process.execPath, writtenAtUs: WRITTEN }));
  const probe = (pids) => new Map(pids.map((pid) => [pid, pid === PID
    ? { alive: true, createdAtUs: WRITTEN - 1, commandLine: `node "${process.execPath}"` } : { alive: false, createdAtUs: null, commandLine: null }]));
  const ended = [];
  const state = bootDaemonAgentState({ aifyHome, url: "http://127.0.0.1:1", pid: process.pid, nowUs: () => NOW, probe,
    onAgentEnded: (id) => ended.push(id) });
  t.after(() => state.residents.release({ waitMs: 0 }));
  state.host.startManaged({ agentId: "worker", lifetime: "7f3c9e2a-0000-4000-8000-0000000000d2", instance: state.instance,
    pid: 77, handle: "h", cwd: null, definition: null });
  state.host.endManaged("7f3c9e2a-0000-4000-8000-0000000000d2");
  assert.deepEqual(ended, ["worker"]);
  assert.equal(await state.residents.acquire(), true, "CONTROL: this daemon holds the residents role");
  fs.rmSync(file);
  state.residents.refresh();
  assert.deepEqual(ended, ["worker", "lead"]);
});

test("the sessions folder is always under a home the caller names", () => {
  assert.equal(sessionsRoot("/home/op"), path.join("/home/op", ".aify", "sessions"));
  assert.throws(() => sessionsRoot(), /needs the home/, "a forgotten home would be the operator's own");
});

test("the route and the command: what `agents remove` says about the folder", async () => {
  const asked = [];
  const sessionFolders = { forget: async (id) => { asked.push(id); return { agentId: id, removed: true, reason: "not-running" }; } };
  const answer = await handleRequest({ method: "DELETE", path: "/agents/worker/session-folder" }, { sessionFolders });
  assert.deepEqual([answer.status, answer.body, asked], [200, { agentId: "worker", removed: true, reason: "not-running" }, ["worker"]]);
  assert.equal((await handleRequest({ method: "DELETE", path: "/agents/worker/session-folder" }, {})).status, 503);
  assert.equal((await handleRequest({ method: "GET", path: "/agents/worker/session-folder" }, { sessionFolders })).status, 405);

  assert.equal(sessionFolderLine("w", { removed: true, reason: "not-running" }, true), "its session folder was removed");
  assert.match(sessionFolderLine("w", { removed: false, reason: "running" }, true), /stays while w runs; aify-env removes it when w stops/);
  assert.equal(sessionFolderLine("w", { removed: false, reason: "absent" }, false), "");
  assert.match(sessionFolderLine("w", { problem: "no aify-env" }, true), /next aify-env start removes it/);
  assert.equal(sessionFolderLine("w", { problem: "no aify-env" }, false), "", "nothing to say about a folder that is not there");

  const store = { remove: async (id) => ({ id, trashName: `${id}.json` }) };
  const told = [];
  const result = await runAgents({ verb: "remove", id: "worker" }, { store, installed: INSTALLED,
    sessionFolder: async (id) => { told.push(id); return { agentId: id, removed: true, reason: "not-running", problem: "" }; } });
  assert.deepEqual(told, ["worker"]);
  assert.deepEqual(result.lines, ["worker removed to .trash/worker.json", "its session folder was removed"]);
});

test("A REAL DAEMON: its start removes what was left, keeps the rest, and answers the command after a removal", async (t) => {
  const scratch = tempDir(t, "aify-session-daemon-");
  const env = sealedDaemonEnv({ AIFY_SERVICE_REGISTRY: path.join(scratch, "no-registry.json"),
    AIFY_ENV_PROCESS_RECORD: path.join(scratch, "owned.json") });
  const home = env.USERPROFILE;
  const root = sessionsRoot(home);
  for (const name of ["left", "kept", "_pid-1"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  const store = new DefinitionStore({ dir: path.join(home, ".aify", "agent-definitions") });
  await store.set("kept", agent("kept", home), { installed: INSTALLED });

  const child = spawn(process.execPath, [DAEMON, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => { child.on("exit", resolve); child.kill(); });
  });
  // Both: the folder can go before the daemon prints where it listens, under a loaded run (seen 2026-10-28).
  const listening = () => /listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output);
  const deadline = Date.now() + 30_000;
  while ((fs.existsSync(path.join(root, "left")) || !listening()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(!fs.existsSync(path.join(root, "left")), `the start left an undefined agent's folder. Daemon said:\n${output}`);
  assert.ok(fs.existsSync(path.join(root, "kept")), "a defined agent's folder went");
  assert.ok(fs.existsSync(path.join(root, "_pid-1")), "the launcher's own folder went");

  const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
  assert.ok(base, `the daemon never said where it listens:\n${output}`);
  assert.deepEqual(await forgetSessionFolder({ endpoint: base, agentId: "kept" }),
    { agentId: "kept", removed: false, reason: "defined", problem: "" }, "the daemon removed a defined agent's folder");

  const removed = spawnSync(process.execPath, [AGENTS, "remove", "kept"], { encoding: "utf8", timeout: 60_000,
    env: { ...env, AIFY_ENV_ENDPOINT: base } });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /its session folder was removed/);
  assert.ok(!fs.existsSync(path.join(root, "kept")));
});
