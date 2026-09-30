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
