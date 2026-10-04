#!/usr/bin/env node
// What another plugin adds to a defined worker's environment at start (the `spawnEnv` capability; aify-dashboard
// docs/DESIGN-SECRETS-INJECTION.md, B and C, with its 2026-10-03 review). Driven through the real control path with a
// real store; contributors are fakes, since what the host does with their answer is the subject.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { definitionProblems, PLUGIN_SUPPLIED_FIELDS } from "../lib/agent-definition-schema.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { contributedEnv, layeredEnv, SPAWN_ENV_WAIT_MS } from "../lib/plugins/aify-comms/spawn-env.mjs";
import { Runner } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses } from "../lib/service-plugins.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const SECRETS = { project: "p1", names: ["OPENAI_API_KEY"] };
// A field given as undefined is left out, which is how a definition names no secrets.
const agent = (over = {}) => Object.fromEntries(Object.entries({ name: "Lead", role: "coder", harness: "claude", mode: "managed",
  workspace: "C:/work", model: "", effort: "", instructions: "", env: {}, herdrSpace: true, secrets: SECRETS, ...over })
  .filter(([, value]) => value !== undefined));

async function definedLead(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-spawn-env-"));
  const store = new DefinitionStore({ dir, lockWaitMs: 300 });
  await store.set("lead", agent(over), { installed: ALL });
  const { storeId } = await store.list();
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: ["claude-aify", "--aify-agent", "lead"],
    cwd: "C:/work", env: {}, definition: { storeId, incarnation: 1, revision: 1 } };
  return { dir, store, launch };
}

/** A fake contributor of `secrets`: answers `answer` (or what `answer` returns), and records what it was asked. */
function contributor(answer, asked = []) {
  return { service: "aify-dashboard", field: "secrets", async contribute(request) { asked.push(request); return typeof answer === "function" ? answer(request) : answer; } };
}

async function start({ store, launch }, contributors, { baseEnv = {}, beforeAdmit } = {}) {
  const reports = [];
  const starts = [];
  const api = {
    async launch() { return { launch }; },
    async reportControl(id, patch) { reports.push({ id, ...patch }); },
    async terminalOutput() { return {}; },
  };
  const processes = {
    async start(spec) { starts.push(spec); return { id: "proc-1", pid: 1, cols: 80, rows: 24 }; },
    subscribe() { return () => {}; },
    list() { return []; },
  };
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, api, processes, handles: createHandleBook(),
    cwdRoots: ["C:/work"], windows: true, withinRoots: workspaceWithinRoots,
    buildSpec: ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } }),
    resolveCandidates: () => ["C:/bin/claude-aify"], baseEnv,
    admitStart: async (l, produce) => { await beforeAdmit?.(); return store.admitStart(l, produce); },
    definitionFor: (l) => store.boundReading(l),
    spawnEnv: () => contributors,
  });
  return { result, reports, starts };
}

test("a defined worker's env carries what a contributor answers, and the contributor is asked with the host's definition", async () => {
  const lead = await definedLead();
  const asked = [];
  const { result, starts } = await start(lead, [contributor({ env: { OPENAI_API_KEY: "sentinel-value" } }, asked)]);
  assert.equal(result.outcome, "started", JSON.stringify(result));
  assert.equal(starts[0].env.OPENAI_API_KEY, "sentinel-value");
  assert.deepEqual(asked[0].definition.secrets, SECRETS, "the names come from this host's file, never the launch");
  assert.ok(asked[0].signal instanceof AbortSignal, "a signal the host aborts at its own bound");
});

test("a start with no definition asks no contributor at all", async () => {
  // The bug: a network call on every spawn, comms-only ones included.
  const lead = await definedLead();
  const asked = [];
  const { result } = await start({ ...lead, launch: { ...lead.launch, definition: undefined } }, [contributor({ env: { X: "y" } }, asked)]);
  assert.equal(result.outcome, "started");
  assert.equal(asked.length, 0);
});

test("a contributor's refusal, its error or a malformed answer refuses the start, naming the service", async () => {
  // The bug: a worker started without the secrets its definition names, as if fetching them were optional.
  const cases = [
    [contributor({ refused: "secret OPENAI_API_KEY for project p1 was refused: 404 no_such_secret" }), /aify-dashboard: secret OPENAI_API_KEY for project p1 was refused: 404 no_such_secret/],
    [{ service: "aify-dashboard", field: "secrets", async contribute() { throw new Error("no fetch credential"); } }, /aify-dashboard: no fetch credential/],
    [contributor({ env: { OPENAI_API_KEY: 5 } }), /aify-dashboard: answered in the wrong shape/],
    [contributor({ env: [] }), /aify-dashboard: answered in the wrong shape/],
    [contributor(null), /aify-dashboard: answered in the wrong shape/],
  ];
  for (const [who, reason] of cases) {
    const lead = await definedLead();
    const { result, reports, starts } = await start(lead, [who]);
    assert.equal(result.outcome, "refused", String(reason));
    assert.match(result.detail, reason);
    assert.equal(starts.length, 0, "nothing was started");
    assert.match(reports.at(-1).error, reason, "and the service is told why");
  }
});

test("a contributor that never answers, and ignores its signal, is given up on at the bound and refuses", { timeout: 10_000 }, async () => {
  // The bug: one hung fetch holds every later start. The bound is the host's, so a contributor that ignores the
  // signal it is handed still cannot hold it. Asked directly with a short bound; the start path uses SPAWN_ENV_WAIT_MS.
  let signal;
  const began = Date.now();
  const answer = await contributedEnv({ contributors: [{ service: "aify-dashboard", contribute: (asked) => { signal = asked.signal; return new Promise(() => {}); } }],
    definition: {}, waitMs: 200 });
  assert.match(answer.refused, /aify-dashboard: did not answer within 0\.2 s/);
  assert.ok(Date.now() - began < 2_000, "bounded");
  assert.equal(signal.aborted, true, "and the contributor is told to stop");
  assert.ok(SPAWN_ENV_WAIT_MS > 10_000 && SPAWN_ENV_WAIT_MS <= 30_000, "above the contributor's own 10 s request limit, and bounded");
});

test("a definition naming secrets, on a host where no started plugin supplies them, is refused, not started bare", async () => {
  // The bug: with no contributor for `secrets`, nobody fetches, nothing refuses, and the worker runs without what its
  // definition names (rule 5). That is every host where aify-dashboard is not a started plugin, or declined. A
  // contributor of something else does not count, and a definition that names no secrets still starts with none.
  const other = { ...contributor({ env: {} }), service: "elsewhere", field: "other" };
  for (const contributors of [[], [other]]) {
    const lead = await definedLead();
    const { result, reports, starts } = await start(lead, contributors);
    assert.equal(result.outcome, "refused", `${contributors.length} contributors`);
    assert.match(result.detail, /lead names secrets, and no plugin started on this host supplies them/);
    assert.equal(starts.length, 0);
    assert.match(reports.at(-1).error, /no plugin started on this host supplies them/);
  }
  const plain = await definedLead({ secrets: undefined });
  const { result } = await start(plain, []);
  assert.equal(result.outcome, "started", JSON.stringify(result));
  // So a supplied field must be optional: a required one would refuse every defined start on a host without its plugin.
  const body = JSON.parse(fs.readFileSync(path.join(plain.dir, "lead.json"), "utf8"));
  for (const field of PLUGIN_SUPPLIED_FIELDS) {
    const { [field]: _left, ...without } = body.agent;
    assert.deepEqual(definitionProblems({ ...body, agent: without }, "lead").filter((p) => p.startsWith(`agent.${field}`)), [], field);
  }
});

test("a defined start with contributors and no store to read its definition from is refused, not started bare", async () => {
  const lead = await definedLead();
  const reports = [];
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, handles: createHandleBook(),
    api: { async launch() { return { launch: lead.launch }; }, async reportControl(id, patch) { reports.push(patch); }, async terminalOutput() { return {}; } },
    processes: { async start() { throw new Error("must not start"); }, subscribe() { return () => {}; }, list() { return []; } },
    cwdRoots: ["C:/work"], windows: true, withinRoots: workspaceWithinRoots, baseEnv: {},
    buildSpec: ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } }),
    resolveCandidates: () => ["C:/bin/claude-aify"], spawnEnv: () => [contributor({ env: { K: "v" } })], definitionFor: null,
  });
  assert.equal(result.outcome, "refused");
  assert.match(result.detail, /no definition store to read the start's definition from/);
});

test("a name the launch or the definition already sets refuses the start, in any case on Windows; an inherited one is replaced", () => {
  // The bug: a silent winner between two sources of one variable.
  const reserved = { launch: { OPENAI_API_KEY: "a" }, definition: {} };
  assert.match(layeredEnv({ OPENAI_API_KEY: "a" }, { openai_api_key: "s" }, { ...reserved, windows: true }).refused,
    /openai_api_key collides with OPENAI_API_KEY, which the launch sets/);
  assert.match(layeredEnv({}, { K: "s" }, { launch: {}, definition: { k: "d" }, windows: true }).refused,
    /K collides with k, which the definition sets/);
  // Not on POSIX, where case makes two names.
  assert.deepEqual(layeredEnv({ k: "d" }, { K: "s" }, { launch: {}, definition: { k: "d" }, windows: false }).env, { k: "d", K: "s" });
  // Over an inherited daemon variable of the same name, in another case, the contribution wins and leaves one spelling.
  assert.deepEqual(layeredEnv({ Openai_Api_Key: "daemon's" }, { OPENAI_API_KEY: "s" }, { launch: {}, definition: {}, windows: true }).env,
    { OPENAI_API_KEY: "s" });
});

test("a value holding NUL refuses the start, named without its value", () => {
  // The bug: an env block cannot carry NUL, so the value would arrive cut short, not refused.
  const refused = layeredEnv({}, { K: "ab\u0000cd" }, { launch: {}, definition: {}, windows: true }).refused;
  assert.match(refused, /K holds a NUL/);
  assert.ok(!refused.includes("ab"), "no part of the value");
});

test("two contributors naming one variable refuse the start", async () => {
  const lead = await definedLead();
  const { result } = await start(lead, [contributor({ env: { K: "1" } }), { ...contributor({ env: { k: "2" } }), service: "other" }]);
  assert.equal(result.outcome, "refused");
  assert.match(result.detail, /two plugins set k: aify-dashboard and other/i);
});

test("a definition edited between the fetch and admission refuses the start", async () => {
  // The bug (D2): the network is outside the definition lock, so the definition can change between the fetch and
  // admission, and a worker started with the old definition's secrets. The fetch reads only the revision the start
  // was bound to, and admission refuses any other, so a changed project or names cannot start.
  const lead = await definedLead();
  const { result, starts } = await start(lead, [contributor({ env: { OPENAI_API_KEY: "s" } })], {
    beforeAdmit: () => lead.store.set("lead", agent({ secrets: { project: "p2", names: ["OPENAI_API_KEY"] } }), { installed: ALL }),
  });
  assert.equal(result.outcome, "refused");
  assert.match(result.detail, /changed since this start was queued/);
  assert.equal(starts.length, 0);
  // The same by hand, on disk, as an operator would edit it: adoption gives it a revision, which admission refuses.
  const byHand = await definedLead();
  const file = path.join(byHand.dir, "lead.json");
  const { result: handResult } = await start(byHand, [contributor({ env: { OPENAI_API_KEY: "s" } })], {
    beforeAdmit: () => { const body = JSON.parse(fs.readFileSync(file, "utf8")); body.agent.secrets.project = "p2"; fs.writeFileSync(file, JSON.stringify(body)); },
  });
  assert.equal(handResult.outcome, "refused");
});

test("a start bound to a revision the host no longer holds asks no contributor", async () => {
  const lead = await definedLead();
  await lead.store.set("lead", agent({ model: "m2" }), { installed: ALL });
  const asked = [];
  const { result } = await start(lead, [contributor({ env: { X: "y" } }, asked)]);
  assert.equal(result.outcome, "refused");
  assert.equal(asked.length, 0, "no fetch for a definition this start was not built from");
});

test("the host offers every started plugin's spawnEnv, and a plugin with none adds nothing", () => {
  const processes = new PluginProcesses(new Runner({ openTerminal: () => null }));
  assert.deepEqual(new PluginHost({ processes }).spawnEnv(), [], "none by default");
  const offered = [contributor({ env: {} })];
  assert.equal(new PluginHost({ processes, spawnEnv: () => offered }).spawnEnv(), offered);
});
