// The view shows each agent's harness, model and effort from its definition, and reading them changes nothing (0.9.9).
//
// THE CONDITION ON THE READ (comms-tech-lead, 2026-10-28): every DefinitionStore call takes the lock, recovers,
// adopts hand edits and makes its folders. A view refreshing every few seconds doing that is one more writer racing
// the operator's edits. So the view reads through readOnlySummary(): no folder, no lock, no adoption, no write, and
// only a file whose bytes the ledger adopted.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { readDefinitionSummary } from "../lib/definition-summary.mjs";
import { formatDefinitionFile } from "../lib/agent-definition-schema.mjs";
import { renderDashboard } from "../lib/tui.mjs";
import { layoutFrom } from "../lib/tui-layout.mjs";
import { collectSnapshot } from "../lib/view-snapshot.mjs";

const INSTALLED = new Set(["claude", "codex"]);
const agent = (id, over = {}) => ({ id, name: id, role: "worker", harness: "claude", mode: "managed", workspace: os.tmpdir(),
  model: "opus", effort: "high", instructions: "never shown", env: { TOKEN: "never shown" }, herdrSpace: false, ...over });

async function definedStore(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-view-definitions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "definitions");
  const store = new DefinitionStore({ dir });
  await store.set("lead", agent("lead"), { installed: INSTALLED });
  await store.set("coder", agent("coder", { harness: "codex", model: "gpt-5", effort: "medium" }), { installed: INSTALLED });
  return { home, dir, store };
}

/** Every folder and file under `root`, files by their bytes: what "changed nothing" is measured against. */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) { out[`${rel}/`] = ""; walk(full); } else out[rel] = fs.readFileSync(full).toString("base64");
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** The view's own collection, with the daemon down and every other ambient read sealed. */
const collect = (home, dir) => collectSnapshot({ endpoint: "http://127.0.0.1:9", registryPath: path.join(home, "no-registry.json"),
  fetchImpl: async () => { throw new Error("not answering"); }, readCredentialStore: async () => ({ names: [] }),
  readInvocationRegistries: () => [], readDefinitions: () => new DefinitionStore({ dir }).readOnlySummary() });

test("the view's refresh leaves the store byte for byte as it was: no new folder, no lock file, nothing written", async (t) => {
  const { home, dir } = await definedStore(t);
  const before = tree(home);
  assert.ok(Object.keys(before).some((name) => name.endsWith("lead.json")), "CONTROL: the tree sees the definitions");
  const snapshot = await collect(home, dir);
  await collect(home, dir);
  assert.deepEqual(tree(home), before, "the view's read changed the store");
  assert.deepEqual(snapshot.definitions, {
    coder: { harness: "codex", model: "gpt-5", effort: "medium" },
    lead: { harness: "claude", model: "opus", effort: "high" },
  }, "the summary is the three fields and nothing else: never env or instructions");
});

test("a hand edit is not adopted by the view: it stays blank, and the ledger is untouched, until the store adopts it", async (t) => {
  const { dir, store } = await definedStore(t);
  const file = path.join(dir, "lead.json");
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, formatDefinitionFile({ ...body, agent: { ...body.agent, model: "sonnet" } }));
  const ledger = fs.readFileSync(path.join(dir, ".collection.json"));
  const viewed = new DefinitionStore({ dir }).readOnlySummary();
  assert.equal(viewed.has("lead"), false, "the view showed a hand edit the store has not adopted");
  assert.equal(viewed.get("coder")?.model, "gpt-5", "one edited file cost the other agents their fields");
  assert.deepEqual(fs.readFileSync(path.join(dir, ".collection.json")), ledger, "the view's read adopted the edit");
  await store.list();
  assert.equal(new DefinitionStore({ dir }).readOnlySummary().get("lead")?.model, "sonnet",
    "CONTROL: the edit is one the store adopts, so the blank was the view's restraint, not a broken file");
});

test("a definition or ledger that cannot be read costs only its own fields, never the read", async (t) => {
  const { dir } = await definedStore(t);
  fs.writeFileSync(path.join(dir, "lead.json"), "{ not json");
  assert.deepEqual([...new DefinitionStore({ dir }).readOnlySummary().keys()], ["coder"]);
  fs.writeFileSync(path.join(dir, ".collection.json"), "{ not json");
  assert.equal(new DefinitionStore({ dir }).readOnlySummary().size, 0);
});

const SNAPSHOT = {
  version: "0.9.9-dev", endpoint: "http://127.0.0.1:8802", nowMs: 1_000_000, terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 1 }, traffic: {},
  processes: [{ id: "x-p1", pid: 1, label: "worker", service: "aify-comms", terminal: true, uptimeMs: 1, title: "" }],
  agentRecords: { worker: { agentId: "worker", state: "working" } },
};
const CHOSEN = layoutFrom(JSON.stringify({ columns: { agents: { normal: ["agent", "harness", "model", "effort"] } } }));
const rowOf = (lines) => lines.find((line) => line.includes("worker")) ?? "";

test("the three fields render as columns tui.json may name", () => {
  assert.deepEqual(CHOSEN.problems, []);
  const lines = renderDashboard({ ...SNAPSHOT, definitions: { worker: { harness: "claude", model: "opus", effort: "high" } } },
    { columns: 120, layout: CHOSEN, keys: { enabled: false, canQuit: false } });
  assert.match(lines.find((line) => /\bAGENT\b/.test(line)) ?? "", /^\s*AGENT\s+HARNESS\s+MODEL\s+EFFORT$/);
  assert.match(rowOf(lines), /^\s*worker\s+claude\s+opus\s+high$/);
});

test("an absent store renders blanks and is not made by the read", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-view-no-definitions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "definitions");
  const snapshot = await collect(home, dir);
  assert.deepEqual(snapshot.definitions, {});
  assert.equal(fs.existsSync(dir), false, "the view's read made the store's folder");
  const lines = renderDashboard({ ...SNAPSHOT, definitions: snapshot.definitions },
    { columns: 120, layout: CHOSEN, keys: { enabled: false, canQuit: false } });
  assert.match(rowOf(lines), /^\s*worker\s*$/);
  await new DefinitionStore({ dir }).list();
  assert.equal(fs.existsSync(dir), true, "CONTROL: a store call does make it, so the check above can say yes");
});

test("THE DEFAULT READ, as the view makes it with nothing injected, is the read-only one", async (t) => {
  // WITH A HAND EDIT PENDING, because a store call on a settled store leaves no trace to see: here one would adopt it.
  const { home, dir } = await definedStore(t);
  const coder = path.join(dir, "coder.json");
  const body = JSON.parse(fs.readFileSync(coder, "utf8"));
  fs.writeFileSync(coder, formatDefinitionFile({ ...body, agent: { ...body.agent, model: "edited by hand" } }));
  const before = tree(home);
  const saved = process.env.AIFY_AGENT_DEFINITIONS_DIR;
  process.env.AIFY_AGENT_DEFINITIONS_DIR = dir;
  try {
    const snapshot = await collectSnapshot({ endpoint: "http://127.0.0.1:9", registryPath: path.join(home, "no-registry.json"),
      fetchImpl: async () => { throw new Error("not answering"); }, readCredentialStore: async () => ({ names: [] }),
      readInvocationRegistries: () => [] });
    assert.equal(snapshot.definitions.lead?.model, "opus", "the default read did not read this store");
  } finally {
    if (saved === undefined) delete process.env.AIFY_AGENT_DEFINITIONS_DIR; else process.env.AIFY_AGENT_DEFINITIONS_DIR = saved;
  }
  assert.deepEqual(tree(home), before, "the view's default read changed the store");
});

test("a file whose adopted bytes no longer pass today's rules is left blank, as the store would refuse it", async (t) => {
  // The ledger adopted these exact bytes under the rules of their day; a later schema can find them invalid.
  const { dir } = await definedStore(t);
  const bytes = Buffer.from(formatDefinitionFile({ agent: { id: "lead", harness: "claude" } }));
  fs.writeFileSync(path.join(dir, "lead.json"), bytes);
  const ledgerFile = path.join(dir, ".collection.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.ids.lead.fileDigest = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.deepEqual([...new DefinitionStore({ dir }).readOnlySummary().keys()], ["coder"]);
});

test("a definitions read that throws costs the view those fields, never its frame", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-view-definitions-throw-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const snapshot = await collectSnapshot({ endpoint: "http://127.0.0.1:9", registryPath: path.join(home, "no-registry.json"),
    fetchImpl: async () => { throw new Error("not answering"); }, readCredentialStore: async () => ({ names: [] }),
    readInvocationRegistries: () => [], readDefinitions: () => { throw new Error("EACCES"); } });
  assert.deepEqual(snapshot.definitions, {});
  assert.equal(snapshot.answered, false, "CONTROL: the rest of the snapshot was still collected");
});

test("readDefinitionSummary reads only the folder it is handed, and the store hands it its own", async (t) => {
  const { dir } = await definedStore(t);
  assert.deepEqual(readDefinitionSummary(dir), new DefinitionStore({ dir }).readOnlySummary());
  assert.equal(readDefinitionSummary(dir).get("lead")?.model, "opus", "CONTROL: the folder it was handed is read");
  assert.equal(readDefinitionSummary(path.join(dir, "elsewhere")).size, 0, "another folder is not this store");
});
