#!/usr/bin/env node
// `aify-env agents`: its argument rules (pure), and the command itself run as a child process against
// a temporary store, with a PATH holding one launcher so the harness check is real. The dispatcher
// (bin/aify-env.mjs) is never run here: a misrouted argument there starts a daemon.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyChanges, parseAgentsArgs } from "../bin/aify-env-agents.mjs";

const COMMAND = fileURLToPath(new URL("../bin/aify-env-agents.mjs", import.meta.url));
const LAUNCHER = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

test("THE ARGUMENTS: each verb's shape, and anything else refused with a reason", () => {
  assert.deepEqual(parseAgentsArgs(["list"]), { verb: "list", problem: "" });
  assert.deepEqual(parseAgentsArgs(["recover", "--as-not-committed"]), { verb: "recover", choice: "not-committed", problem: "" });
  const set = parseAgentsArgs(["set", "a", "name=Coder", "herdrSpace=false", "env.KEY=x=y", "-env.OLD"]);
  assert.deepEqual(set.changes, [{ key: "name", value: "Coder" }, { key: "herdrSpace", value: false }, { env: "KEY", value: "x=y" }, { unsetEnv: "OLD" }]);
  for (const [argv, why] of [
    [[], /no verb/], [["start"], /unknown verb/], [["list", "x"], /no arguments/], [["show"], /exactly one id/],
    [["set", "a"], /at least one/], [["set", "a", "name"], /not key=value/], [["set", "a", "incarnation=5"], /unknown key/],
    [["set", "a", "herdrSpace=yes"], /true or false/], [["recover"], /as-committed/],
  ]) assert.match(parseAgentsArgs(argv).problem, why, JSON.stringify(argv));
});

test("A NEW DEFINITION gets the stated defaults; an existing one keeps what the changes do not touch", () => {
  const fresh = applyChanges(undefined, [{ key: "name", value: "N" }]);
  assert.deepEqual(fresh, { model: "", effort: "", instructions: "", env: {}, herdrSpace: true, name: "N" });
  const current = { id: "a", name: "Old", env: { A: "1", B: "2" }, herdrSpace: false };
  const next = applyChanges(current, [{ env: "C", value: "3" }, { unsetEnv: "A" }]);
  assert.deepEqual(next.env, { B: "2", C: "3" });
  assert.equal(next.herdrSpace, false);
  assert.equal("id" in next, false, "the id comes from the command, never the old body");
  assert.deepEqual(current.env, { A: "1", B: "2" }, "the current definition is not mutated");
});

test("THE COMMAND end to end: set, list, show, remove, and a refusal that exits 65 with the problems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-agents-cmd-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude-aify"), LAUNCHER);
  const env = { ...process.env, PATH: bin, AIFY_AGENT_DEFINITIONS_DIR: path.join(root, "defs") };
  const run = (...args) => spawnSync(process.execPath, [COMMAND, ...args], { env, encoding: "utf8" });

  const made = run("set", "coder-1", "name=Coder One", "role=coder", "harness=claude", "mode=managed", "workspace=C:/w");
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /coder-1: incarnation 1 revision 1/);
  const edited = run("set", "coder-1", "model=opus");
  assert.match(edited.stdout, /revision 2/, "a change to one key keeps the rest");
  assert.match(run("list").stdout, /coder-1 {2}claude\/managed {2}incarnation 1 revision 2/);
  assert.equal(JSON.parse(run("show", "coder-1").stdout).agent.model, "opus");

  const noLauncher = run("set", "coder-2", "name=Two", "role=coder", "harness=codex", "mode=managed", "workspace=C:/w");
  assert.equal(noLauncher.status, 65);
  assert.match(noLauncher.stderr, /codex launcher is not installed/);
  const incomplete = run("set", "coder-3", "name=Three");
  assert.equal(incomplete.status, 65);
  assert.match(incomplete.stderr, /agent\.harness: missing/, "a new definition's required fields are named");

  assert.equal(run("remove", "coder-1").status, 0);
  assert.match(run("list").stdout, /no agents are defined/);
  assert.equal(run("show", "coder-1").status, 65);
  assert.equal(run("bogus").status, 64);
});

// ── many agents at once (0.9.1): a configured model reaches each agent's next start ──────────────

test("SET MANY: one selector, model and effort only, a dry run unless --yes", () => {
  assert.deepEqual(parseAgentsArgs(["set", "--harness", "claude", "model=opus", "--yes"]),
    { verb: "set", select: { harness: "claude" }, changes: [{ key: "model", value: "opus" }], write: true, problem: "" });
  assert.deepEqual(parseAgentsArgs(["set", "--ids", "a,b", "effort=high"]).select, { ids: ["a", "b"] });
  assert.equal(parseAgentsArgs(["set", "--all", "model="]).write, false);
  for (const [argv, why] of [
    [["set", "--all"], /at least one/], [["set", "--all", "name=x"], /model and effort only/],
    [["set", "--all", "--ids", "a", "model=x"], /one of --all/], [["set", "--ids", "model=x"], /--ids needs a value/],
    [["set", "--yes", "model=x"], /needs an id, or one of/],
  ]) assert.match(parseAgentsArgs(argv).problem, why, JSON.stringify(argv));
});

test("SET MANY end to end: before and after, nothing written without --yes, then each written once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-agents-many-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude-aify"), LAUNCHER);
  const env = { ...process.env, PATH: bin, AIFY_AGENT_DEFINITIONS_DIR: path.join(root, "defs") };
  const run = (...args) => spawnSync(process.execPath, [COMMAND, ...args], { env, encoding: "utf8" });
  for (const id of ["a", "b"]) {
    assert.equal(run("set", id, "name=N", "role=coder", "harness=claude", "mode=managed", "workspace=C:/w").status, 0);
  }
  const model = (id) => JSON.parse(run("show", id).stdout).agent.model;

  const dry = run("set", "--harness", "claude", "model=opus");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN.*2 change/);
  assert.match(dry.stdout, /^a {2}model: \(harness default\) -> opus$/m);
  assert.deepEqual([model("a"), model("b")], ["", ""], "a dry run writes nothing");

  const wrote = run("set", "--harness", "claude", "model=opus", "--yes");
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(wrote.stdout, /written: a revision 2[\s\S]*written: b revision 2/);
  assert.deepEqual([model("a"), model("b")], ["opus", "opus"]);
  assert.match(run("set", "--all", "model=opus", "--yes").stdout, /^a {2}unchanged$/m, "an unchanged agent is not rewritten");
  assert.match(run("show", "a").stdout, /"revision": 2/);

  const named = run("set", "--ids", "a,nope", "effort=high", "--yes");
  assert.equal(named.status, 65, "a named agent that is not defined fails the command");
  assert.match(named.stdout, /nope {2}skipped: not defined on this host/);
  assert.equal(JSON.parse(run("show", "a").stdout).agent.effort, "high", "the defined one is still written");
});

test("SET MANY writes each agent only as it was read: one changed in between is not overwritten", async () => {
  const { runAgents } = await import("../bin/aify-env-agents.mjs");
  const { DefinitionRefused } = await import("../lib/agent-definitions.mjs");
  const asked = [];
  const store = {
    list: async () => ({ definitions: [{ id: "a", incarnation: 3, revision: 7, agent: { harness: "claude", model: "" } }],
      recovered: [], unreadable: [] }),
    set: async (id, agent, { expect }) => { asked.push({ id, model: agent.model, expect }); throw new DefinitionRefused("changed on the host since you asked"); },
  };
  const intent = parseAgentsArgs(["set", "--all", "model=opus", "--yes"]);
  const { code, lines } = await runAgents(intent, { store, installed: new Set(["claude"]) });
  assert.deepEqual(asked, [{ id: "a", model: "opus", expect: { incarnation: 3, revision: 7 } }]);
  assert.equal(code, 65);
  assert.ok(lines.includes("not written: a (changed on the host since you asked)"), lines.join("\n"));
});

test("MODELS: each agent's set model beside the one its session runs, by the session the services name", async () => {
  const { runAgents } = await import("../bin/aify-env-agents.mjs");
  assert.deepEqual(parseAgentsArgs(["models"]), { verb: "models", problem: "" });
  assert.match(parseAgentsArgs(["models", "x"]).problem, /no arguments/);
  const definition = (id, harness, model) => ({ id, incarnation: 1, revision: 1, agent: { harness, workspace: "C:/w", model } });
  const store = { list: async () => ({ definitions: [definition("a", "claude", ""), definition("b", "hermes", "gpt-6"),
    definition("c", "claude", "opus"), definition("d", "claude", "")], recovered: [], unreadable: [] }) };
  const importable = async () => ({ problem: "", services: [
    { service: "aify-comms", agents: [{ id: "a", sessionHandle: "s-a" }, { id: "b", sessionHandle: "h-b" }, { id: "c", sessionHandle: "s-c" }] },
    { service: "other", agents: [{ id: "c", sessionHandle: "s-other" }] },
    { service: "quiet", agents: [], problem: "refused" },
  ] });
  const asked = [];
  const actual = async (query) => {
    asked.push(query);
    return query.handle ? { model: `ran-${query.handle}`, at: "t" } : { unknown: "no session handle" };
  };
  const { code, lines } = await runAgents(parseAgentsArgs(["models"]), { store, importable, actual });
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    "quiet did not answer: refused",
    "a  claude  set: (harness default)  runs: ran-s-a (last answered t)",
    "b  hermes  set: gpt-6  runs: ran-h-b (last answered t)",
    "c  claude  set: opus  runs: UNKNOWN, the services name different sessions: s-c, s-other",
    "d  claude  set: (harness default)  runs: UNKNOWN, no session handle",
  ]);
  assert.deepEqual(asked.map((q) => [q.harness, q.workspace, q.handle]),
    [["claude", "C:/w", "s-a"], ["hermes", "C:/w", "h-b"], ["claude", "C:/w", ""]], "a disputed session is not read");
});
