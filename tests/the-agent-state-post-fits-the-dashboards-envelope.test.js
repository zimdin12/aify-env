// The agent-state POST fits the dashboard's envelope (docs/AGENT-STATE-DASHBOARD-v1.md, agreed 2026-10-28).
//
// THE DASHBOARD REFUSES A WHOLE PUSH for one top-level field it does not list. On 2026-10-20 aify-env added `build` and
// no agent state was applied there for 17 hours. So the lists are read from the doc, not repeated here, and every
// body is a real one from the publisher: a field added to it fails this test until the doc, and the dashboard, move.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { AgentStatePublisher } from "../lib/agent-state-publisher.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DOC = fs.readFileSync(path.join(HERE, "..", "docs", "AGENT-STATE-DASHBOARD-v1.md"), "utf8");

/** The doc's ```envelope block as {kind: {required: Set, optional: Set}}, `every` folded into each kind. */
function envelopeFromDoc(text) {
  const block = /```envelope\n([\s\S]*?)```/.exec(text)?.[1];
  assert.ok(block, "the doc has no ```envelope block");
  const lines = Object.fromEntries(block.trim().split("\n").map((line) => {
    const [kind, fields] = line.split(":");
    return [kind.trim(), fields.trim().split(/\s+/)];
  }));
  const kinds = {};
  for (const kind of Object.keys(lines).filter((name) => name !== "every")) {
    const fields = [...lines.every, ...lines[kind]];
    kinds[kind] = {
      required: new Set(fields.filter((field) => !field.endsWith("?"))),
      optional: new Set(fields.filter((field) => field.endsWith("?")).map((field) => field.slice(0, -1))),
    };
  }
  return kinds;
}

const ENVELOPE = envelopeFromDoc(DOC);
const NOW_MS = 1_793_156_000_000;

const record = (agentId, lifetime, over = {}) => ({
  agentId, lifetime, state: "working", stateCause: "turn-open", busy: true, name: agentId, role: "coder",
  process: { state: "running", verified: true, pid: 4242 },
  launch: { cwd: "C:/work", definition: { revision: 1 } },
  turn: { open: true, startedAtUs: (NOW_MS - 60_000) * 1000, lastEventAtUs: NOW_MS * 1000, awaitingInput: false },
  ...over,
});

const publisher = (over = {}) => new AgentStatePublisher({
  machineId: "machine-1", instance: "default", generation: 7, incarnationId: "inc-1",
  build: "0.9.7-dev+a87775e", reportEveryMs: 60_000, nowMs: () => NOW_MS, ...over,
});

/**
 * One body of every kind the publisher makes: with build and cadence, without them, and given a build and a cadence the
 * dashboard would refuse, which the publisher must leave out rather than send.
 */
function everyBody() {
  const bodies = [];
  for (const options of [{}, { build: null, reportEveryMs: null }, { build: "has a space", reportEveryMs: 500 }]) {
    const p = publisher(options);
    const first = p.snapshot({ complete: true, agents: [record("alpha", "life-1"), record("beta", null, { state: "stopped" })],
      inputs: { screens: "27" } });
    bodies.push(first.body);
    // A new lifetime for alpha: alpha is changed under life-2 and life-1 is removed.
    const next = p.changes({ complete: true, agents: [record("alpha", "life-2"), record("beta", null, { state: "stopped" })] }, first.view);
    bodies.push(next.body);
    // Only a state word moves: a changes body that removes nothing still carries `removed`, empty.
    bodies.push(p.changes({ complete: true, agents: [record("alpha", "life-2", { state: "idle" }), record("beta", null, { state: "stopped" })] },
      next.view).body);
    bodies.push(p.snapshot({ complete: false, reason: "observation-incomplete", inputs: {} }).body);
    bodies.push(p.retire().body);
  }
  return bodies;
}

const depth = (value) => (value && typeof value === "object" ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0);

test("POSITIVE CONTROL: the doc's block names all four kinds, and the publisher makes each of them", () => {
  assert.deepEqual(Object.keys(ENVELOPE).sort(), ["changes", "retired", "snapshot", "unavailable"]);
  assert.deepEqual([...new Set(everyBody().map((body) => body.kind))].sort(), ["changes", "retired", "snapshot", "unavailable"]);
  const changes = everyBody().find((body) => body.kind === "changes");
  assert.equal(changes.removed.length, 1, "the changes body removes nothing, so the removal rule below is untested");
});

test("every body's top-level fields are its kind's list from the doc: nothing extra, nothing required missing", () => {
  for (const body of everyBody()) {
    const { required, optional } = ENVELOPE[body.kind];
    for (const key of Object.keys(body)) {
      assert.ok(required.has(key) || optional.has(key), `a ${body.kind} body carries ${key}, which the dashboard refuses`);
    }
    for (const key of required) assert.ok(key in body, `a ${body.kind} body has no ${key}`);
  }
});

test("every value is within the dashboard's bounds", () => {
  for (const body of everyBody()) {
    const where = `${body.kind} #${body.publication}`;
    assert.ok(Number.isSafeInteger(body.generation) && body.generation >= 1, `${where}: generation ${body.generation}`);
    assert.ok(Number.isSafeInteger(body.publication) && body.publication >= 0, `${where}: publication ${body.publication}`);
    assert.ok(typeof body.incarnationId === "string" && body.incarnationId, `${where}: incarnationId`);
    if ("build" in body) assert.match(body.build, /^[\x21-\x7e]{1,200}$/, `${where}: build`);
    if ("reportEveryMs" in body) {
      assert.ok(Number.isSafeInteger(body.reportEveryMs) && body.reportEveryMs >= 1000 && body.reportEveryMs <= 3_600_000,
        `${where}: reportEveryMs ${body.reportEveryMs}`);
    }
    if ("inputs" in body) {
      assert.ok(body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs), `${where}: inputs`);
      for (const value of Object.values(body.inputs)) assert.equal(typeof value, "string", `${where}: an input that is not a string`);
    }
    assert.ok(depth(body) <= 64, `${where}: nested ${depth(body)} levels`);
    if (body.kind === "snapshot") assert.equal(body.complete, true, `${where}: complete`);
    if (body.kind === "changes") assert.ok(Array.isArray(body.removed), `${where}: removed`);
    if (body.kind === "unavailable") assert.ok(typeof body.reason === "string" && body.reason, `${where}: reason`);
    if (body.kind === "retired") assert.ok(["shutdown", "operator-attested"].includes(body.reason), `${where}: reason`);
  }
});

test("every record has its agentId and lifetime, and no lifetime is both changed and removed in one push", () => {
  for (const body of everyBody()) {
    for (const row of body.agents ?? []) {
      assert.ok(typeof row.agentId === "string" && row.agentId, `${body.kind}: a record without its agentId`);
      assert.ok(row.lifetime === null || (typeof row.lifetime === "string" && row.lifetime), `${body.kind}: ${row.agentId}'s lifetime`);
    }
    const changed = new Set((body.agents ?? []).map((row) => row.lifetime).filter(Boolean));
    for (const row of body.removed ?? []) assert.ok(!changed.has(row.lifetime), `${row.lifetime} is both changed and removed`);
  }
});

test("NEGATIVE CONTROL: the checks refuse what the dashboard refuses", () => {
  const body = everyBody()[0];
  const { required, optional } = ENVELOPE[body.kind];
  const extra = { ...body, debug: true };
  assert.ok(Object.keys(extra).some((key) => !required.has(key) && !optional.has(key)), "a field the doc does not list went unnoticed");
  assert.ok(!ENVELOPE.retired.optional.has("reportEveryMs") && !ENVELOPE.retired.required.has("reportEveryMs"),
    "retired admits reportEveryMs, which the dashboard refuses");
  assert.ok(depth({ a: { b: { c: 1 } } }) === 3, "the depth measure is off");
});
