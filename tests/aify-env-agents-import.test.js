#!/usr/bin/env node
// `aify-env agents import` end to end (P0 C10): the command as a child process against a temporary store,
// asking a stand-in daemon on an ephemeral loopback port. The dispatcher (bin/aify-env.mjs) is never run.
//
// What it proves, as the phase says: a dry run writes nothing; a conflict is listed and not written;
// env is reported as unavailable; and `--write` defines only the rows marked import, never over an
// existing definition.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAgentsArgs, runAgents } from "../bin/aify-env-agents.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";

const COMMAND = fileURLToPath(new URL("../bin/aify-env-agents.mjs", import.meta.url));
const LAUNCHER = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
const agent = (over = {}) => ({ name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w",
  model: "opus", effort: "", instructions: "", env: {}, herdrSpace: true, ...over });

function daemon(services) {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/agents/importable" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ services, defined: null, definedProblem: "", problem: "" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function run(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMMAND, "import", ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("THE ARGUMENTS: --write and repeated --prefer, and nothing else", () => {
  assert.deepEqual(parseAgentsArgs(["import"]), { verb: "import", write: false, prefer: [], problem: "" });
  assert.deepEqual(parseAgentsArgs(["import", "--prefer", "a:x", "--write", "--prefer", "b"]),
    { verb: "import", write: true, prefer: [{ service: "a", id: "x" }, { service: "b", id: "" }], problem: "" });
  assert.match(parseAgentsArgs(["import", "--prefer"]).problem, /--prefer needs/);
  assert.match(parseAgentsArgs(["import", "--prefer", "--write"]).problem, /--prefer needs/, "a flag is not a service name");
  assert.match(parseAgentsArgs(["import", "lead"]).problem, /does not take 'lead'/);
});

test("DRY RUN writes nothing; --write defines the import rows only, never a conflict or an existing id", async (t) => {
  const server = await daemon([
    { service: "aify-comms", problem: "", agents: [
      { id: "lead", agent: agent(), unreported: ["env"] },
      { id: "kept", agent: agent({ model: "from-service" }), unreported: ["env"] },
      { id: "split", agent: agent(), unreported: ["env"] },
      { id: "nolauncher", agent: agent({ harness: "codex" }), unreported: ["env"] },
    ] },
    { service: "other", problem: "", agents: [{ id: "split", agent: agent({ model: "sonnet" }), unreported: ["env"] }] },
  ]);
  t.after(() => server.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-agents-import-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude-aify"), LAUNCHER);
  const defs = path.join(root, "defs");
  const env = { ...process.env, PATH: bin, AIFY_AGENT_DEFINITIONS_DIR: defs,
    AIFY_ENV_ENDPOINT: `http://127.0.0.1:${server.address().port}` };
  const set = spawn(process.execPath, [COMMAND, "set", "kept", "name=Kept", "role=coder", "harness=claude", "mode=managed", "workspace=C:/k"], { env });
  assert.equal(await new Promise((resolve) => set.on("close", resolve)), 0);
  const files = () => fs.readdirSync(defs).filter((name) => name.endsWith(".json")).sort();
  const before = files();

  const dry = await run(env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(files(), before, "the dry run wrote nothing");
  assert.match(dry.stdout, /^DRY RUN: nothing is written/m);
  assert.match(dry.stdout, /^lead {2}import, from aify-comms$/m);
  assert.match(dry.stdout, /not reported by aify-comms: env \(written as \{\}\)/);
  assert.match(dry.stdout, /^kept {2}already defined here; not overwritten/m);
  assert.match(dry.stdout, /^split {2}conflict between aify-comms and other/m);
  assert.match(dry.stdout, /^ {6}model: aify-comms "opus", other "sonnet"$/m);
  assert.match(dry.stdout, /^nolauncher {2}invalid, so not written, from aify-comms$/m);
  assert.match(dry.stdout, /^ {6}problem: the codex launcher is not installed on this host$/m);

  const wrote = await run(env, "--write");
  assert.equal(wrote.status, 0, wrote.stderr + wrote.stdout);
  assert.match(wrote.stdout, /^written: lead incarnation \d+ revision 1$/m);
  assert.deepEqual(files(), [...before, "lead.json"].sort(), "only the import row was written");
  assert.equal(JSON.parse(fs.readFileSync(path.join(defs, "kept.json"), "utf8")).agent.workspace, "C:/k", "kept was not overwritten");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(defs, "lead.json"), "utf8")).agent.env, {});

  const chosen = await run(env, "--write", "--prefer", "other:split");
  assert.match(chosen.stdout, /^written: split incarnation \d+ revision 1$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(defs, "split.json"), "utf8")).agent.model, "sonnet");
});

test("A SERVICE THAT DID NOT ANSWER: listed, and --write writes nothing, since its conflict cannot show", async (t) => {
  const server = await daemon([
    { service: "aify-comms", problem: "", agents: [{ id: "lead", agent: agent(), unreported: ["env"] }] },
    { service: "other", problem: "connect ECONNREFUSED", agents: [] },
  ]);
  t.after(() => server.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-agents-import-"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "claude-aify"), LAUNCHER);
  const env = { ...process.env, PATH: path.join(root, "bin"), AIFY_AGENT_DEFINITIONS_DIR: path.join(root, "defs"),
    AIFY_ENV_ENDPOINT: `http://127.0.0.1:${server.address().port}` };
  const wrote = await run(env, "--write");
  assert.equal(wrote.status, 65);
  assert.match(wrote.stdout, /^other did not answer: connect ECONNREFUSED$/m);
  assert.match(wrote.stdout, /nothing written: ask again when every service answers/);
  assert.equal(fs.existsSync(path.join(root, "defs", "lead.json")), false);
});

test("NO DAEMON: said, and exit 65", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-agents-import-"));
  const silent = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const result = await run({ ...process.env, AIFY_AGENT_DEFINITIONS_DIR: path.join(root, "defs"), AIFY_ENV_ENDPOINT: `http://127.0.0.1:${silent}` });
  assert.equal(result.status, 65);
  assert.match(result.stdout, /no service could be asked: the environment did not answer/);
});

const reportOf = (...agents) => async () => ({ services: [{ service: "aify-comms", problem: "", agents }], defined: null, definedProblem: "", problem: "" });

test("AN ID DEFINED BETWEEN THE PLAN AND THE WRITE is refused by the store, never overwritten", async () => {
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-agents-import-")), lockWaitMs: 300 });
  const installed = new Set(["claude"]);
  await store.set("lead", agent({ model: "mine" }), { installed });
  // The plan reads a listing taken before `lead` was defined; the write meets the store as it is now.
  const late = { list: async () => ({ ...(await store.list()), definitions: [] }), set: (...args) => store.set(...args) };
  const result = await runAgents({ verb: "import", write: true, prefer: [] },
    { store: late, installed, importable: reportOf({ id: "lead", agent: agent(), unreported: ["env"] }) });
  assert.equal(result.code, 65);
  assert.match(result.lines.join("\n"), /^not written: lead \(it already exists\)$/m);
  assert.equal((await store.list()).definitions[0].agent.model, "mine");
});

test("A STORE AWAITING A RECOVERY DECISION: the import says so and plans nothing", async () => {
  const conflict = { intent: { operation: "o", op: "set", id: "x" }, before: "a", current: { present: false } };
  const store = { list: async () => ({ definitions: [], unreadable: [], conflict }), set: async () => assert.fail("nothing may be written") };
  const result = await runAgents({ verb: "import", write: true, prefer: [] },
    { store, installed: new Set(["claude"]), importable: reportOf({ id: "lead", agent: agent(), unreported: ["env"] }) });
  assert.equal(result.code, 65);
  assert.match(result.lines.join("\n"), /RECOVERY CONFLICT/);
  assert.doesNotMatch(result.lines.join("\n"), /^lead /m);
});

test("AN ID WHOSE FILE CANNOT BE READ is still defined here: planned as such, never written over", async () => {
  const store = { list: async () => ({ definitions: [], unreadable: ["lead"], conflict: null }), set: async () => assert.fail("nothing may be written") };
  const result = await runAgents({ verb: "import", write: true, prefer: [] },
    { store, installed: new Set(["claude"]), importable: reportOf({ id: "lead", agent: agent(), unreported: ["env"] }) });
  assert.equal(result.code, 0);
  assert.match(result.lines.join("\n"), /^lead {2}already defined here; not overwritten/m);
});
