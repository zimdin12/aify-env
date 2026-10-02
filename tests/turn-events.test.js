// Which lifetime's turn an event may touch, and in what order (lib/turn-events.mjs; 0.9 P0 C3, review of 591d172f R1).

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { applyTurnEvent, restoreTurn, turnIsBusy } from "../lib/turn-events.mjs";

const LAW = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-state-law.json", import.meta.url), "utf8"));

const NEW = "7f3c9e2a-0000-4000-8000-00000000000a";
const OLD = "7f3c9e2a-0000-4000-8000-00000000000b";
const current = (lifetime) => ({ current: { lifetime }, conflict: null, unknown: [] });
const openAt = (at, startedAtUs = at) => ({ open: true, startedAtUs, awaitingInput: false, lastEventAtUs: at });
const ev = (kind, firedAtUs, lifetime = NEW) => ({ kind, firedAtUs, lifetime });

test("EVERY TABLE ROW through admission and ordering, and every difference from today names its reason", () => {
  for (const row of LAW.hookOrder) {
    const turns = row.last ? { [row.last.owner]: openAt(row.last.at) } : {};
    const lifetimes = row.current ? current(row.current) : undefined;
    const event = { kind: row.event.kind, firedAtUs: row.event.at ?? undefined, lifetime: row.event.owner };
    const result = applyTurnEvent(turns, event, lifetimes);
    assert.deepEqual({ applied: result.applied, reason: result.reason }, row.aifyEnv, row.name);
    assert.equal(Boolean(row.divergence), row.aifyEnv.applied !== row.accept,
      `${row.name}: a row that differs from today says why, and only such a row`);
  }
});

test("R1: AN UNBOUND END, early or late, leaves the bound turn exactly as it was", () => {
  const turns = { [NEW]: openAt(200) };
  for (const at of [100, 300]) {
    const result = applyTurnEvent(turns, ev("turn-end", at, ""), current(NEW));
    assert.deepEqual([result.applied, result.reason], [false, "unbound"], `at ${at}`);
    assert.equal(result.turns, turns, `at ${at}: the same object, nothing re-anchored or reset`);
  }
  const bound = applyTurnEvent(turns, ev("turn-end", 300), current(NEW));
  assert.deepEqual([bound.applied, bound.turns[NEW].open], [true, false], "CONTROL: the bound end at 300 closes it");
});

test("A LIFETIME THAT IS NOT CURRENT touches nothing: an old one, an unadopted agent, a conflict", () => {
  const turns = { [NEW]: openAt(200), [OLD]: openAt(50) };
  assert.equal(applyTurnEvent(turns, ev("turn-end", 900, OLD), current(NEW)).reason, "not-current", "a delayed end from the old lifetime");
  assert.equal(applyTurnEvent(turns, ev("turn-start", 900), undefined).reason, "not-current", "no record at all");
  assert.equal(applyTurnEvent(turns, ev("turn-start", 900), { current: null, conflict: null, unknown: [] }).reason, "not-current");
  const conflict = { current: null, conflict: [{ lifetime: NEW }, { lifetime: OLD }], unknown: [] };
  for (const kind of ["turn-start", "turn-end", "blocked", "unblocked"]) {
    const result = applyTurnEvent(turns, ev(kind, 900), conflict);
    assert.deepEqual([result.applied, result.reason, result.turns], [false, "conflict", turns], kind);
  }
});

test("AN UNKNOWN IDENTITY: its retained turn closes on its own end, and nothing renews or re-anchors it (C3)", () => {
  const turns = { [NEW]: openAt(200, 150) };
  const unknown = { current: null, conflict: null, unknown: [{ lifetime: NEW }] };
  for (const kind of ["turn-start", "blocked", "unblocked"]) {
    const result = applyTurnEvent(turns, ev(kind, 900), unknown);
    assert.deepEqual([result.applied, result.reason, result.turns], [false, "identity-unknown", turns], kind);
  }
  assert.equal(applyTurnEvent(turns, ev("turn-end", 100), unknown).reason, "out-of-order", "a stale end is still ordered");
  const ended = applyTurnEvent(turns, ev("turn-end", 300), unknown);
  assert.deepEqual([ended.applied, ended.reason, ended.turns[NEW].open], [true, "retained-end:later", false]);
});

test("NO USABLE TIME, or a kind this version does not apply, is refused before any ordering", () => {
  const turns = { [NEW]: openAt(200) };
  for (const at of [undefined, null, 0, -1, 1.5, "300", 2 ** 53]) {
    const result = applyTurnEvent(turns, ev("turn-end", at), current(NEW));
    assert.deepEqual([result.applied, result.reason, result.turns], [false, "no-timestamp", turns], String(at));
  }
  const odd = applyTurnEvent(turns, ev("compacted", 900), current(NEW));
  assert.deepEqual([odd.applied, odd.reason, odd.turns], [false, "unknown-kind", turns]);
  assert.equal(applyTurnEvent(turns, ev("turn-end", 250), current(NEW)).applied, true, "CONTROL: 250 still applies after both");
});

test("THE EFFECTS are today's: a start keeps an open turn's anchor, blocked marks it, and an end closes it", () => {
  let turns = {};
  const step = (event) => { const result = applyTurnEvent(turns, event, current(NEW)); turns = result.turns; return result; };
  step(ev("turn-start", 100));
  step(ev("turn-start", 400));
  assert.deepEqual(turns[NEW], { open: true, startedAtUs: 100, awaitingInput: false, lastEventAtUs: 400 }, "the anchor stays at 100");
  step(ev("blocked", 500));
  assert.equal(turns[NEW].awaitingInput, true);
  step(ev("unblocked", 600));
  assert.equal(turns[NEW].awaitingInput, false);
  step(ev("turn-end", 700));
  assert.deepEqual(turns[NEW], { open: false, startedAtUs: 0, awaitingInput: false, lastEventAtUs: 700 });
  assert.equal(step(ev("turn-start", 650)).reason, "out-of-order", "a slow start after its own end: the closed record orders it");
  assert.equal(step(ev("turn-start", 800)).applied, true, "CONTROL: a later start opens the next turn");
  assert.equal(turns[NEW].startedAtUs, 800);
});

test("AWAITING INPUT belongs to one turn: a start or an end clears it, and blocked never opens a turn", () => {
  let turns = {};
  const step = (event) => { turns = applyTurnEvent(turns, event, current(NEW)).turns; return turns[NEW]; };
  step(ev("turn-start", 100));
  assert.equal(step(ev("blocked", 150)).awaitingInput, true);
  assert.deepEqual([step(ev("turn-end", 200)).awaitingInput, turns[NEW].open], [false, false], "an end clears it");
  assert.deepEqual([step(ev("blocked", 300)).open, turns[NEW].awaitingInput], [false, true], "blocked after the end opens nothing");
  assert.equal(step(ev("turn-start", 400)).awaitingInput, false, "the next turn does not start blocked");
  step(ev("blocked", 450));
  assert.deepEqual([step(ev("unblocked", 500)).awaitingInput, turns[NEW].open], [false, true], "unblocked leaves the turn open");
});

test("ONLY AN OPEN TURN IS BUSY: a closed one keeps its last event, and that never holds it", () => {
  const nowUs = 10_000_000_000;
  const closed = { open: false, startedAtUs: 0, awaitingInput: false, lastEventAtUs: nowUs - 10_000_000 };
  assert.equal(turnIsBusy(closed, { nowUs, renewable: false }), false);
  assert.equal(turnIsBusy(closed, { nowUs, renewable: true }), false);
  assert.equal(turnIsBusy(undefined, { nowUs, renewable: false }), false);
  const open = { ...closed, open: true, startedAtUs: nowUs - 60_000_000 };
  assert.equal(turnIsBusy(open, { nowUs, renewable: false }), true, "CONTROL: open for 60 s is busy, its times in microseconds");
  const old = { ...open, startedAtUs: nowUs - 1_801_000_000 };
  assert.equal(turnIsBusy(old, { nowUs, renewable: false }), false, "past the strict window");
  assert.equal(turnIsBusy(old, { nowUs, renewable: true }), true, "renewed by its last event, 10 s ago");
});

test("A STORED RECORD WITHOUT A USABLE LAST EVENT orders nothing, rather than taking any event as the first", () => {
  const damaged = { [NEW]: { open: true, startedAtUs: 100, awaitingInput: false } };
  const result = applyTurnEvent(damaged, ev("turn-end", 1), current(NEW));
  assert.deepEqual([result.applied, result.reason, result.turns], [false, "unordered-record", damaged]);
  assert.equal(applyTurnEvent({}, ev("turn-end", 1), current(NEW)).applied, true, "CONTROL: no record at all is a first event");
  const named = applyTurnEvent({}, ev("turn-start", 5, "constructor"), current("constructor"));
  assert.deepEqual([named.applied, named.reason, named.turns.constructor.open], [true, "current:first", true],
    "a lifetime named like an inherited property is still its own record");
});

test("A STORED TURN after a restart: restored for yes, closed for no, kept unrenewed for unknown (C3)", () => {
  assert.deepEqual(restoreTurn("yes"), { keep: true, renewable: true, cause: "restored" });
  assert.deepEqual(restoreTurn("no"), { keep: false, renewable: false, cause: "lifetime-ended" });
  assert.deepEqual(restoreTurn("unknown"), { keep: true, renewable: false, cause: "identity-unknown" });
});
