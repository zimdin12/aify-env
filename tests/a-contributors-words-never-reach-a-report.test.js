#!/usr/bin/env node
// No text a spawnEnv contributor produces reaches what the host reports or logs (aify-dashboard
// docs/DESIGN-SECRETS-INJECTION.md, "The spawnEnv repair: plan revision 1").
//
// AT THE CONSUMER. A real DefinitionStore, the real `runOneControl` and its report helper, and a real `CommsApi` over a
// fake fetch that keeps every request it is handed, with the host's log lines. Each arm puts a sentinel in exactly one
// place a contributor controls. It must refuse with the host's fixed sentence, start nothing, and leave the sentinel in
// no request and no log line.
//
// EVERY ARM HAS A REACHABLE COUNTERPART: the same shape made valid. It must reach its own outcome, which is a start
// with the value in the worker's spec and nowhere else, or the host's sentence for a valid refusal. So a refusal arm
// cannot pass by being refused for some other reason before it gets there.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { ENV_NAME_PATTERN, suppliedNames } from "../lib/agent-definition-schema.mjs";
import { CommsApi } from "../lib/plugins/aify-comms/api.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const S = `sentinel${randomBytes(8).toString("hex")}`;
const NAME = `SENTINEL_${randomBytes(6).toString("hex").toUpperCase()}`;
const LEAD = { name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/work", model: "", effort: "",
  instructions: "", env: {}, herdrSpace: true, secrets: { project: "p1", names: ["OPENAI_API_KEY"] } };

/** One start through the real path: what it answered, what the comms client sent, what was logged, what started. */
async function startWith(contributors, { secrets = true, launchEnv = {}, baseEnv = {} } = {}) {
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-contrib-words-")), lockWaitMs: 300 });
  const { secrets: _named, ...bare } = LEAD;
  await store.set("lead", secrets ? LEAD : bare, { installed: ALL });
  const { storeId } = await store.list();
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: ["claude-aify"], cwd: "C:/work",
    env: launchEnv, definition: { storeId, incarnation: 1, revision: 1 } };
  const sent = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    sent.push(JSON.stringify({ url, method: init.method, body: init.body ?? "" }));
    return url.endsWith("/terminals/term-1/launch") ? json({ launch }) : json({ ok: true });
  };
  const api = new CommsApi({ endpoint: "http://comms.invalid", credential: async () => "api-key-for-the-test", identity: { bridgeId: "b" }, fetchImpl });
  const logs = [];
  const starts = [];
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, api, handles: createHandleBook(), log: (line) => logs.push(line),
    processes: { async start(spec) { starts.push(spec); return { id: "proc-1", pid: 1 }; }, subscribe() { return () => {}; }, list() { return []; } },
    cwdRoots: ["C:/work"], windows: true, withinRoots: workspaceWithinRoots, baseEnv,
    buildSpec: ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } }),
    resolveCandidates: () => ["C:/bin/claude-aify"],
    admitStart: (l, produce) => store.admitStart(l, produce), definitionFor: (l) => store.boundReading(l),
    spawnEnv: () => contributors,
  });
  const reported = sent.map((s) => JSON.parse(s)).filter((r) => r.method === "PATCH").map((r) => JSON.parse(r.body));
  const persisted = await store.boundReading(launch);
  return { result, sent, logs, starts, reported, persisted };
}

const secrets = (answer) => ({ service: "aify-dashboard", field: "secrets", contribute: typeof answer === "function" ? answer : async () => answer });
const anyField = (answer) => ({ contribute: async () => answer });
const value = (name = "OPENAI_API_KEY") => ({ env: { [name]: S } });
const valid = (name) => [secrets(value())].concat(name ? [anyField(value(name))] : []);
const notFound = "a plugin: OPENAI_API_KEY was not found where it is kept";
const WRONG = "a plugin answered in the wrong shape";

/** The arms: `bad` refuses with exactly `reason`; `good` is the same shape made valid and reaches `goodReason` or a start. */
function arms() {
  const throwingAccessor = { get env() { throw new Error(S); } };
  let envReads = 0;
  const envAccessor = { env: { get OPENAI_API_KEY() { envReads += 1; return S; } } };
  const proxy = new Proxy({}, { ownKeys() { throw new Error(S); }, getOwnPropertyDescriptor() { throw new Error(S); } });
  const protoEnv = {};
  Object.defineProperty(protoEnv, "__proto__", { value: S, enumerable: true, writable: true, configurable: true });
  return [
    { id: "a thrown error", bad: [secrets(() => { throw new Error(S); })], reason: "a plugin failed", good: [secrets(() => value())] },
    { id: "a rejection", bad: [secrets(async () => { throw new Error(S); })], reason: "a plugin failed", good: valid() },
    { id: "a string refusal", bad: [secrets({ refused: S })], reason: WRONG, good: [secrets({ refused: { reason: "not-found", variable: "OPENAI_API_KEY" } })], goodReason: notFound },
    { id: "a reason not on the list", bad: [secrets({ refused: { reason: S } })], reason: WRONG, good: [secrets({ refused: { reason: "not-found" } })], goodReason: "a plugin: a variable it supplies was not found where it is kept" },
    { id: "a variable the definition does not name", bad: [secrets({ refused: { reason: "not-found", variable: S } })], reason: WRONG, good: [secrets({ refused: { reason: "not-found", variable: "OPENAI_API_KEY" } })], goodReason: notFound },
    { id: "a throwing answer accessor", bad: [secrets(throwingAccessor)], reason: WRONG, good: valid() },
    { id: "an env accessor", bad: [secrets(envAccessor)], reason: WRONG, good: valid(), after: () => assert.equal(envReads, 0, "the accessor was never invoked") },
    { id: "an answer whose proxy throws", bad: [secrets(proxy)], reason: "a plugin failed", good: valid() },
    { id: "an offer that is a throwing proxy", bad: [proxy], reason: "a plugin failed", good: valid() },
    { id: "a symbol key on the answer", bad: [secrets({ ...value(), [Symbol(S)]: 1 })], reason: WRONG, good: valid() },
    { id: "a symbol key in the env", bad: [secrets({ env: { OPENAI_API_KEY: "v", [Symbol(S)]: S } })], reason: WRONG, good: valid() },
    { id: "a malformed outer answer", bad: [secrets(S)], reason: WRONG, good: valid() },
    { id: "an array for an answer", bad: [secrets([S])], reason: WRONG, good: valid() },
    { id: "a malformed refusal carrier", bad: [secrets({ refused: [S] })], reason: WRONG, good: [secrets({ refused: { reason: "not-found", variable: "OPENAI_API_KEY" } })], goodReason: notFound },
    { id: "a refusal and an env together", bad: [secrets({ refused: { reason: "not-found" }, ...value() })], reason: WRONG, good: valid() },
    { id: "a legal-looking service label", needle: "sentinel-valid-source", bad: [{ ...secrets({ refused: { reason: "not-found" } }), service: "sentinel-valid-source" }],
      reason: "a plugin: a variable it supplies was not found where it is kept", good: [{ ...secrets(value()), service: "sentinel-valid-source" }] },
    { id: "a malformed service label", bad: [{ ...secrets({ refused: { reason: "not-found" } }), service: `${S}!` }], reason: "a plugin: a variable it supplies was not found where it is kept",
      good: [{ ...secrets(value()), service: `${S}!` }] },
    { id: "a malformed env name", bad: [secrets({ env: { OPENAI_API_KEY: "v", [`${S}=x`]: "v" } })], reason: "a plugin set a variable name this host does not accept", good: valid() },
    { id: "a well-formed name the field does not name", needle: NAME, bad: [secrets({ env: { OPENAI_API_KEY: "v", [NAME]: "v" } })], reason: "a plugin set a variable its field does not name", good: valid() },
    { id: "an unnamed name in a collision", needle: NAME, launchEnv: { [NAME.toLowerCase()]: "x" }, bad: valid(NAME), reason: "a variable a plugin set collides with a variable the launch sets",
      good: valid(NAME), goodLaunchEnv: {} },
    { id: "an unnamed name holding a NUL", needle: NAME, bad: [secrets(value()), anyField({ env: { [NAME]: `a\u0000${S}` } })], reason: "a variable a plugin set holds a NUL, which an environment block cannot carry",
      good: valid(NAME) },
    { id: "an own __proto__", bad: [secrets({ env: protoEnv })], reason: "__proto__ cannot be carried into a worker's environment on this host", good: valid(),
      before: () => assert.equal(Object.getOwnPropertyDescriptor(protoEnv, "__proto__")?.value, S, "the specimen holds an own string __proto__") },
    { id: "an unknown declared field", bad: [{ ...secrets(value()), field: "keys" }], reason: "a plugin declares a field this host does not supply", good: valid() },
    { id: "a missing required supplier", bad: [], reason: "lead names secrets, and no plugin started on this host supplies them", good: valid() },
  ];
}

const holds = (texts, needle) => texts.some((text) => text.toLowerCase().includes(needle.toLowerCase()));

for (const arm of arms()) {
  test(`${arm.id}: refused in the host's words, nothing started, nothing of it sent or logged; its valid twin reaches its own end`, async () => {
    const needle = arm.needle ?? S;
    arm.before?.();
    const bad = await startWith(arm.bad, { launchEnv: arm.launchEnv });
    assert.equal(bad.result.outcome, "refused", JSON.stringify(bad.result));
    assert.equal(bad.result.detail, arm.reason);
    assert.equal(bad.starts.length, 0, "nothing started");
    assert.deepEqual(bad.reported.map((patch) => [patch.status, patch.error]), [["failed", arm.reason]], "the serialised report says exactly that");
    assert.ok(!holds([...bad.sent, ...bad.logs], needle), "the sentinel is in no request and no log line");
    arm.after?.();
    const good = await startWith(arm.good, { launchEnv: arm.goodLaunchEnv ?? arm.launchEnv });
    if (arm.goodReason) {
      assert.equal(good.result.detail, arm.goodReason, "the valid twin reaches its own refusal");
    } else {
      assert.equal(good.result.outcome, "started", JSON.stringify(good.result));
      const names = Object.keys(good.starts[0].env);
      assert.ok(names.includes("OPENAI_API_KEY"), "the value reached the spec");
      assert.ok(Object.values(good.starts[0].env).includes(S), "as the sentinel");
    }
    assert.ok(!holds([...good.sent, ...good.logs], S), "and the value is in the spec only");
  });
}

// ⛔ THE DEFINITION A CONTRIBUTOR IS HANDED IS NOT THE HOST'S. The bug: the contributor got the host's own bound object,
// which the host read again after the callback, for the requested names and for the env it layered on.
// A contributor that appended a name, or planted an accessor or a proxy, steered the host's own reading.
const E = `planted${randomBytes(8).toString("hex")}`;
const mutating = (mutate, answer) => secrets(async ({ definition }) => { mutate(definition); return answer; });

for (const arm of [
  { id: "a name appended to the requested names, then refused by it", needle: NAME,
    bad: mutating((d) => d.secrets.names.push(NAME), { refused: { reason: "not-found", variable: NAME } }), reason: WRONG,
    good: secrets({ refused: { reason: "not-found", variable: "OPENAI_API_KEY" } }), goodReason: notFound },
  { id: "a name appended to the requested names, then contributed", needle: NAME,
    bad: mutating((d) => d.secrets.names.push(NAME), { env: { OPENAI_API_KEY: S, [NAME]: "v" } }), reason: "a plugin set a variable its field does not name",
    good: secrets(value()) },
]) {
  test(`MUTATION: ${arm.id} is judged by the host's own reading, not the copy it handed out; the twin reaches its own end`, async () => {
    const bad = await startWith([arm.bad]);
    assert.equal(bad.result.detail, arm.reason, JSON.stringify(bad.result));
    assert.equal(bad.starts.length, 0, "nothing started");
    assert.deepEqual(bad.reported.map((patch) => [patch.status, patch.error]), [["failed", arm.reason]]);
    assert.ok(!holds([...bad.sent, ...bad.logs], arm.needle), "the appended name is in no request and no log line");
    assert.deepEqual(bad.persisted.agent.secrets.names, ["OPENAI_API_KEY"], "the store still names only what it was given");
    const good = await startWith([arm.good]);
    if (arm.goodReason) assert.equal(good.result.detail, arm.goodReason);
    else assert.equal(good.result.outcome, "started", JSON.stringify(good.result));
  });
}

for (const arm of [
  { id: "an accessor planted on the definition's secrets", plant: (d) => { Object.defineProperty(d, "secrets", { get() { arm.reads += 1; throw new Error(E); }, configurable: true }); } },
  { id: "a proxy planted as the definition's env", plant: (d) => { d.env = new Proxy({}, { ownKeys() { arm.reads += 1; throw new Error(E); } }); } },
]) {
  arm.reads = 0;
  test(`PLANTED: ${arm.id} never runs in the host; the start goes on as the store defines it, and nothing of it is sent`, async () => {
    const run = await startWith([mutating(arm.plant, value())]);
    assert.equal(run.result.outcome, "started", JSON.stringify(run.result));
    assert.equal(run.starts[0].env.OPENAI_API_KEY, S, "the value the contributor gave reached the spec");
    assert.equal(arm.reads, 0, "the host never ran what was planted");
    assert.ok(!holds([...run.sent, ...run.logs], E), "nothing of it is in a request or a log line");
    assert.deepEqual(run.persisted.agent.secrets.names, ["OPENAI_API_KEY"]);
    const twin = await startWith([secrets(value())]);
    assert.equal(twin.result.outcome, "started", JSON.stringify(twin.result));
  });
}

test("a definition the host cannot copy is the host's sentence, and spawnEnvFor never throws", async () => {
  // Containment for the host's own reading: a bound definition holding an exotic value refuses, and asks no contributor.
  const { spawnEnvFor } = await import("../lib/plugins/aify-comms/spawn-env.mjs");
  let asked = 0;
  const agent = { ...LEAD, env: new Proxy({}, { ownKeys() { throw new Error(E); } }) };
  const answer = await spawnEnvFor({ launch: { agentId: "lead", definition: { storeId: "s", incarnation: 1, revision: 1 }, env: {} }, env: {},
    contributors: [secrets(async () => { asked += 1; return value(); })], definitionFor: async () => ({ agent }), windows: true });
  assert.deepEqual(answer, { refused: "this host could not read the start's definition" });
  assert.equal(asked, 0, "no contributor was asked");
});

test("an inherited daemon variable of the same name, in another case, is replaced, leaving one spelling", async () => {
  const run = await startWith(valid(), { baseEnv: { Openai_Api_Key: "daemon's" } });
  assert.equal(run.result.outcome, "started");
  assert.deepEqual(Object.keys(run.starts[0].env).filter((key) => key.toUpperCase() === "OPENAI_API_KEY"), ["OPENAI_API_KEY"]);
  assert.equal(run.starts[0].env.OPENAI_API_KEY, S);
});

test("a definition that names no secrets starts with no contributor at all", async () => {
  const run = await startWith([], { secrets: false });
  assert.equal(run.result.outcome, "started", JSON.stringify(run.result));
});

test("the schema exports the env-name rule and the supplied names it already held, unchanged", () => {
  // What spawn-env now imports. The D1 fixture and request tests pin that validation and digests did not move.
  assert.equal(ENV_NAME_PATTERN.source, "^[A-Za-z_][A-Za-z0-9_]{0,127}$");
  assert.deepEqual(suppliedNames(LEAD, "secrets"), ["OPENAI_API_KEY"]);
  assert.deepEqual(suppliedNames(LEAD, "env"), [], "a field no plugin supplies names nothing");
  assert.deepEqual(suppliedNames({ name: "x" }, "secrets"), []);
});

test("a store reading that throws becomes the host's sentence, and spawnEnvFor never throws", async () => {
  const { spawnEnvFor } = await import("../lib/plugins/aify-comms/spawn-env.mjs");
  const answer = await spawnEnvFor({ launch: { agentId: "lead", definition: { storeId: "s", incarnation: 1, revision: 1 }, env: {} }, env: {},
    contributors: [secrets(value())], definitionFor: async () => { throw new Error(S); }, windows: true });
  assert.deepEqual(answer, { refused: "this host could not read the start's definition" });
});
