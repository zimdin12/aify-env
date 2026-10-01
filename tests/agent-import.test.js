#!/usr/bin/env node
// `aify-env agents import` plans from what the services report (P0 C10): the pure rules, and aify-comms'
// roster read as definition records. The command end to end is in aify-env-agents-import.test.js.

import assert from "node:assert/strict";
import test from "node:test";

import { HARNESS_RUNTIME } from "../lib/agent-definition-requests.mjs";
import { DECISION, definitionCheck, importPlan, parsePrefer, planLines } from "../lib/agent-import.mjs";
import { importRecord, importRecords } from "../lib/plugins/aify-comms/agent-import-records.mjs";

const agent = (over = {}) => ({ name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w",
  model: "opus", effort: "", instructions: "", env: {}, herdrSpace: true, ...over });
const record = (id, over = {}) => ({ id, agent: agent(over), unreported: ["env"] });
const report = (service, ...agents) => ({ service, agents, problem: "" });
const noProblems = () => [];
const plan = (reports, options = {}) => importPlan({ reports, defined: [], check: noProblems, ...options });
const only = (rows) => { assert.equal(rows.length, 1); return rows[0]; };

test("ONE SERVICE: its record is imported as reported, and what it cannot report is said", () => {
  const row = only(plan([report("aify-comms", record("lead"))]));
  assert.deepEqual([row.decision, row.from, row.sources, row.unreported, row.conflicts], [DECISION.IMPORT, "aify-comms", ["aify-comms"], ["env"], []]);
  assert.deepEqual(row.agent, agent());
});

test("TWO SERVICES THAT AGREE are one import naming both; two that differ are a conflict, field by field", () => {
  const agreed = only(plan([report("b", record("lead")), report("a", record("lead"))]));
  assert.deepEqual([agreed.decision, agreed.sources, agreed.from], [DECISION.IMPORT, ["a", "b"], "a"]);
  const differ = only(plan([report("a", record("lead")), report("b", record("lead", { model: "sonnet", role: "lead" }))]));
  assert.equal(differ.decision, DECISION.CONFLICT);
  assert.equal(differ.agent, null, "nothing is chosen for the operator");
  assert.deepEqual(differ.conflicts, [
    { field: "model", values: [{ service: "a", value: "opus" }, { service: "b", value: "sonnet" }] },
    { field: "role", values: [{ service: "a", value: "coder" }, { service: "b", value: "lead" }] },
  ]);
});

test("--prefer decides a conflict: for one id over every id, and never for a service that did not report it", () => {
  const reports = [report("a", record("x"), record("y")), report("b", record("x", { model: "m" }), record("y", { model: "m" }))];
  const byService = plan(reports, { prefer: [{ service: "b", id: "" }] });
  assert.deepEqual(byService.map((r) => [r.id, r.decision, r.from, r.agent.model]), [["x", DECISION.IMPORT, "b", "m"], ["y", DECISION.IMPORT, "b", "m"]]);
  const mixed = plan(reports, { prefer: [{ service: "a", id: "" }, { service: "b", id: "y" }] });
  assert.deepEqual(mixed.map((r) => [r.id, r.from]), [["x", "a"], ["y", "b"]], "the id's own choice wins over the service-wide one");
  const forOther = plan(reports, { prefer: [{ service: "b", id: "z" }] });
  assert.deepEqual(forOther.map((r) => r.decision), [DECISION.CONFLICT, DECISION.CONFLICT]);
  const absent = plan(reports, { prefer: [{ service: "c", id: "" }] });
  assert.deepEqual(absent.map((r) => r.decision), [DECISION.CONFLICT, DECISION.CONFLICT]);
});

test("AN ID DEFINED HERE is never planned for writing, compared without case as the store compares ids", () => {
  const row = only(plan([report("a", record("Lead"))], { defined: ["lead"] }));
  assert.deepEqual([row.decision, row.agent], [DECISION.DEFINED, null]);
});

test("NOT IMPORTABLE, INVALID, and a service that could not describe an id another could", () => {
  const none = only(plan([report("a", { id: "g", notImportable: "its runtime generic has no harness" })]));
  assert.deepEqual([none.decision, none.notes], [DECISION.NOT_IMPORTABLE, ["a: its runtime generic has no harness"]]);
  const partly = only(plan([report("a", { id: "g", notImportable: "no harness" }), report("b", record("g"))]));
  assert.deepEqual([partly.decision, partly.from, partly.notes, partly.problems], [DECISION.IMPORT, "b", ["a: no harness"], []]);
  const invalid = only(plan([report("a", record("lead"))], { check: (id) => [`${id}: bad`] }));
  assert.deepEqual([invalid.decision, invalid.problems], [DECISION.INVALID, ["lead: bad"]]);
});

test("THE CHECK is the store's rule for a new definition plus an installed launcher", () => {
  const check = definitionCheck(new Set(["claude"]));
  assert.deepEqual(check("lead", agent()), []);
  assert.deepEqual(check("lead", agent({ harness: "codex", mode: "elsewhere" })),
    ["agent.mode: unsupported", "the codex launcher is not installed on this host"]);
});

test("--prefer reads <service> or <service>:<id>, the id after the last colon", () => {
  assert.deepEqual(parsePrefer("aify-comms"), { service: "aify-comms", id: "" });
  assert.deepEqual(parsePrefer("aify-comms:lead"), { service: "aify-comms", id: "lead" });
  assert.deepEqual(parsePrefer("a:b:c"), { service: "a:b", id: "c" });
  assert.equal(parsePrefer("  "), null);
});

test("THE LINES say each decision, every value to be written, and what was not reported", () => {
  const rows = plan([report("a", record("lead", { instructions: "four" }), record("x")), report("b", record("x", { model: "m" }))], { defined: [] });
  const text = planLines(rows).join("\n");
  assert.match(text, /^lead {2}import, from a$/m);
  assert.match(text, /name: "Lead" \| role: "coder" .* instructions: 4 characters/);
  assert.match(text, /not reported by a: env \(written as \{\}\)/);
  assert.match(text, /^x {2}conflict between a and b; not written until you choose with --prefer <service> or --prefer <service>:x$/m);
  assert.match(text, /^ {6}model: a "opus", b "m"$/m);
});

test("THE ROSTER, read as records: this machine only, harness from runtime, aify-comms' names mapped", () => {
  const roster = { agents: {
    lead: { machineId: "WIN32:Host", runtime: "claude-code", name: "Lead", role: "coder", sessionMode: "managed", cwd: "C:/w",
      model: "opus", instructions: "be brief", herdrSpace: false, runtimeConfig: { effort: "high" } },
    thinker: { machineId: "win32:host", runtime: "codex", sessionMode: "resident", runtimeConfig: { thinking: "xhigh" } },
    elsewhere: { machineId: "win32:other", runtime: "codex" },
    nowhere: { runtime: "codex" },
  } };
  const records = importRecords(roster, "win32:host");
  assert.deepEqual(records.map((r) => r.id), ["lead", "thinker"]);
  assert.deepEqual(records[0], { id: "lead", unreported: ["env"], agent: { name: "Lead", role: "coder", harness: "claude",
    mode: "managed", workspace: "C:/w", model: "opus", effort: "high", instructions: "be brief", env: {}, herdrSpace: false } });
  assert.equal(records[1].agent.effort, "xhigh", "thinking when there is no effort, as the service's launch reads it");
  assert.deepEqual(records[1].unreported, ["env", "herdrSpace"], "a service that does not say herdrSpace has it said, not assumed");
  assert.deepEqual(importRecords(roster, ""), [], "no machine id, nothing is this host's");
});

test("EVERY HARNESS maps back from its runtime, and any other runtime is not importable", () => {
  for (const [harness, runtime] of Object.entries(HARNESS_RUNTIME)) {
    assert.equal(importRecord("a", { runtime }).agent.harness, harness, runtime);
  }
  assert.deepEqual(importRecord("a", { runtime: "generic" }), { id: "a", notImportable: "its runtime generic has no harness" });
});
