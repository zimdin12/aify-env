// The state host: lifetime records, stored turns and turn events composed into one word per agent (0.9 plan P0 C3, C4).
//
// Driven in a temporary aify home with a fake OS probe and a fake clock: no real process is asked about, and no file
// outside the temp home is read or written. Each case is a row of C3 or C4, stated in the test name.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { turnsFile } from "../lib/turns-file.mjs";

const L1 = "7f3c9e2a-0000-4000-8000-000000000001";
const L2 = "7f3c9e2a-0000-4000-8000-000000000002";
const WRITTEN = 1_790_950_000_500_123;
const LAUNCHER = "C:/Users/x/bin/claude-aify";
const NOW = WRITTEN + 60_000_000;
const RESIDENT = { definition: "valid", mode: "resident", stoppedByOperator: false };

function homeWith(records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-state-host-"));
  const dir = path.join(home, "residents");
  fs.mkdirSync(dir, { recursive: true });
  for (const record of records) fs.writeFileSync(path.join(dir, `${record.agentId}.${record.lifetime}.json`), JSON.stringify(record));
  return home;
}
const record = (lifetime, pid, extra = {}) => ({ agentId: "lead", lifetime, instance: "default", harness: "claude", pid,
  launcher: LAUNCHER, writtenAtUs: WRITTEN, ...extra });
// What Windows reports for a Git Bash launcher: bash, then the script in its /c/ spelling.
const running = (createdAtUs) => ({ alive: true, createdAtUs, commandLine: `"C:/Program Files/Git/bin/bash.exe" /c/Users/x/bin/claude-aify` });
const probeOf = (answers) => (pids) => new Map(pids.map((pid) => [pid, answers[pid] ?? { alive: false, createdAtUs: null, commandLine: null }]));
const host = (home, answers, nowUs = () => NOW) => new AgentStateHost({ aifyHome: home, instance: "default", probe: probeOf(answers), nowUs });
const word = (state) => [state.state, state.stateCause];

test("FIRST ADOPTION WITH NO STORED TURN reads unknown, not idle, until its next hook (C3, the held gate)", () => {
  const h = host(homeWith([record(L1, 41)]), { 41: running(WRITTEN - 5) });
  h.boot();
  assert.deepEqual(word(h.current("lead", RESIDENT)), ["unknown", "turn-unknown"]);
  assert.equal(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: NOW - 10 }).applied, true);
  assert.deepEqual(word(h.current("lead", RESIDENT)), ["working", "turn-open"], "its first hook makes the turn known");
  h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-end", firedAtUs: NOW - 5 });
  assert.deepEqual(word(h.current("lead", RESIDENT)), ["idle", "at-prompt"], "control: a known closed turn is idle");
});

test("A FRESH SCREEN SIGHTING still decides while the turn is unknown (C3 row 4 outranks the bookkeeping)", () => {
  const h = host(homeWith([record(L1, 41)]), { 41: running(WRITTEN - 5) });
  h.boot();
  assert.deepEqual(word(h.current("lead", { ...RESIDENT, screen: { state: "working", fresh: true } })), ["working", "screen"]);
  assert.deepEqual(word(h.current("lead", { ...RESIDENT, screen: { state: "shell", fresh: true } })), ["unknown", "turn-unknown"],
    "a prompt sighting is not a turn: still unknown");
});

test("A RESTART RESTORES EACH STORED TURN BY ITS LIFETIME'S VERDICT NOW (C3: yes restored, no closed, unknown retained)", () => {
  const open = { open: true, startedAtUs: NOW - 30_000_000, awaitingInput: false, lastEventAtUs: NOW - 20_000_000 };
  const cases = [
    ["yes", { 41: running(WRITTEN - 5) }, ["working", "turn-open"], true],
    ["no (gone)", {}, ["offline", "absent"], false],
    ["unknown (probe unanswered)", { 41: { alive: null, createdAtUs: null, commandLine: null } }, ["unknown", "identity-unknown"], true],
  ];
  for (const [label, answers, expected, kept] of cases) {
    const home = homeWith([record(L1, 41)]);
    fs.mkdirSync(path.join(home, "env"), { recursive: true });
    fs.writeFileSync(turnsFile(home, "default"), JSON.stringify({ [L1]: open }));
    const h = host(home, answers);
    h.boot();
    const state = h.current("lead", RESIDENT);
    assert.deepEqual(word(state), expected, label);
    assert.equal(state.turn?.startedAtUs === open.startedAtUs, kept, `${label}: the stored turn kept with its own start`);
    assert.equal(fs.existsSync(path.join(home, "residents", `lead.${L1}.json`)), label !== "no (gone)",
      `${label}: only a proved-gone lifetime loses its record`);
  }
});

test("A RETAINED TURN IS STRICT: busy until 1800 s from its original start, never renewed (C3 unknown row)", () => {
  const started = NOW - 1_000_000_000;
  const home = homeWith([record(L1, 41)]);
  fs.mkdirSync(path.join(home, "env"), { recursive: true });
  fs.writeFileSync(turnsFile(home, "default"), JSON.stringify({ [L1]: { open: true, startedAtUs: started, awaitingInput: false, lastEventAtUs: NOW - 1_000 } }));
  const unanswered = { 41: { alive: null, createdAtUs: null, commandLine: null } };
  const within = host(home, unanswered, () => started + 1_800_000_000);
  within.boot();
  assert.equal(within.current("lead", RESIDENT).busy, true, "at the window's edge");
  const past = host(home, unanswered, () => started + 1_800_001_000);
  past.boot();
  assert.equal(past.current("lead", RESIDENT).busy, false, "past it, though its last event is recent");
});

test("P-1 RESIDENT AND MANAGED verified quiet turns hold until an admitted end or lifetime exit", (t) => {
  for (const mode of ["resident", "managed"]) {
    const home = homeWith(mode === "resident" ? [record(L1, 41)] : []);
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    let now = NOW;
    const answers = { 41: running(WRITTEN - 5) };
    const h = host(home, answers, () => now);
    const given = { ...RESIDENT, mode };
    h.boot();
    if (mode === "managed") h.startManaged({ agentId: "lead", lifetime: L1, instance: "default", pid: 41, handle: "fixture" });
    assert.equal(h.current("lead", given).process.verified, "yes", `${mode}: selected lifetime is verified`);
    const startedAtUs = NOW - 10;
    assert.equal(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: startedAtUs }).applied, true);
    for (const elapsedUs of [1_800_001_000, 3_600_000_000, 43_200_000_000, 2_592_000_000_000]) {
      now = startedAtUs + elapsedUs;
      h.refresh();
      const row = h.current("lead", { ...given, screen: { state: "idle", fresh: true } });
      assert.equal(row.busy, true, `${mode}: quiet work after ${elapsedUs} us`);
      assert.deepEqual(word(row), ["working", "turn-open"], "an idle screen is not an admitted turn end");
      assert.deepEqual(row.turn.busyIf, { strict: false, verifiedRenewal: true });
      assert.equal(row.turn.startedAtUs, startedAtUs);
      assert.equal(row.turn.lastEventAtUs, startedAtUs, "no renewal or synthetic hook");
    }
    assert.equal(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-end", firedAtUs: now }).applied, true);
    const ended = h.current("lead", given);
    assert.equal(ended.busy, false);
    assert.deepEqual(word(ended), ["idle", "at-prompt"]);
    assert.deepEqual(ended.turn.busyIf, { strict: false, verifiedRenewal: false });
    assert.equal(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: now + 1 }).applied, true);
    now += 43_200_000_000;
    assert.equal(h.current("lead", given).busy, true);
    if (mode === "managed") h.endManaged(L1);
    else { answers[41] = { alive: false, createdAtUs: null, commandLine: null }; h.refresh(); }
    const exited = h.current("lead", given);
    assert.equal(exited.busy, false, "lifetime exit ends the held turn");
    assert.equal(exited.turn, null);
    assert.deepEqual(word(exited), mode === "managed" ? ["available", "startable"] : ["offline", "absent"]);
  }
});

test("P-1 RESTART keeps an old blocked turn without changing its event anchors", (t) => {
  const home = homeWith([record(L1, 41)]);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = NOW;
  const answers = { 41: running(WRITTEN - 5) };
  const first = host(home, answers, () => now);
  first.boot();
  assert.equal(first.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: NOW - 10 }).applied, true);
  assert.equal(first.applyEvent({ agentId: "lead", lifetime: L1, kind: "blocked", firedAtUs: NOW - 5 }).applied, true);
  const stored = fs.readFileSync(turnsFile(home, "default"));
  now += 43_200_000_000;
  const restarted = host(home, answers, () => now);
  restarted.boot();
  const row = restarted.current("lead", RESIDENT);
  assert.equal(row.process.verified, "yes");
  assert.equal(row.busy, true, "verified restart does not age out quiet work");
  assert.deepEqual(word(row), ["blocked", "turn-open"]);
  assert.deepEqual(row.turn.busyIf, { strict: false, verifiedRenewal: true });
  assert.equal(row.turn.startedAtUs, NOW - 10);
  assert.equal(row.turn.lastEventAtUs, NOW - 5);
  assert.deepEqual(fs.readFileSync(turnsFile(home, "default")), stored, "restart must not manufacture a renewal");
});

test("P-1 CURRENT VERIFICATION loss selects strict fallback, then recovery restores the same open turn", (t) => {
  const home = homeWith([record(L1, 41)]);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = NOW;
  const answers = { 41: running(WRITTEN - 5) };
  const h = host(home, answers, () => now);
  h.boot();
  assert.equal(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: NOW - 10 }).applied, true);
  now += 43_200_000_000;
  assert.equal(h.current("lead", RESIDENT).process.verified, "yes");
  assert.equal(h.current("lead", RESIDENT).busy, true);
  answers[41] = { alive: null, createdAtUs: null, commandLine: null };
  h.refresh();
  const unknown = h.current("lead", RESIDENT);
  assert.deepEqual(word(unknown), ["unknown", "identity-unknown"]);
  assert.equal(unknown.process.verified, "unknown");
  assert.equal(unknown.busy, false);
  assert.equal(unknown.turn.open, true, "unanswered identity retains the accepted turn");
  assert.deepEqual(unknown.turn.busyIf, { strict: false, verifiedRenewal: false });
  assert.equal(unknown.turn.startedAtUs, NOW - 10);
  answers[41] = running(WRITTEN - 5);
  h.refresh();
  const recovered = h.current("lead", RESIDENT);
  assert.equal(recovered.busy, true, "recovery must not require a new start or renewal");
  assert.deepEqual(word(recovered), ["working", "turn-open"]);
  assert.equal(recovered.turn.startedAtUs, NOW - 10);
  assert.equal(recovered.turn.lastEventAtUs, NOW - 10);
});

test("P-1 ENUMERATION UNCERTAINTY cannot verify a retained managed current entry", (t) => {
  const home = homeWith([]);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = NOW;
  const h = host(home, {}, () => now);
  const given = { ...RESIDENT, mode: "managed" };
  h.boot();
  h.startManaged({ agentId: "lead", lifetime: L1, instance: "default", pid: 41, handle: "fixture" });
  assert.equal(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: NOW - 10 }).applied, true);
  now += 43_200_000_000;
  assert.equal(h.current("lead", given).busy, true);
  const dir = path.join(home, "residents");
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(dir, "blocked-directory");
  h.refresh();
  const row = h.current("lead", given);
  assert.equal(row.lifetime, L1, "managed current entry is still retained");
  assert.equal(row.process.verified, "unknown", "entry presence is not current verification");
  assert.equal(row.busy, false, "unanswered process facts cannot select the verified hold");
  assert.deepEqual(word(row), ["unknown", "identity-unknown"]);
  assert.deepEqual(row.turn.busyIf, { strict: false, verifiedRenewal: false });
});

test("AN UNREADABLE TURNS FILE RESTORES NOTHING: every adopted agent's turn is unknown, never idle (turns-file)", () => {
  const home = homeWith([record(L1, 41)]);
  fs.mkdirSync(path.join(home, "env"), { recursive: true });
  fs.writeFileSync(turnsFile(home, "default"), "{");
  const h = host(home, { 41: running(WRITTEN - 5) });
  const booted = h.boot();
  assert.match(booted.problems.join("; "), /turns: not JSON/);
  assert.deepEqual(word(h.current("lead", RESIDENT)), ["unknown", "turn-unknown"]);
});

test("A REUSED PID (created after the record) ends the lifetime and removes its record (C4)", () => {
  const home = homeWith([record(L1, 41)]);
  const h = host(home, { 41: running(WRITTEN + 1) });
  h.boot();
  assert.deepEqual(word(h.current("lead", RESIDENT)), ["offline", "absent"]);
  assert.equal(fs.existsSync(path.join(home, "residents", `lead.${L1}.json`)), false);
});

test("TWO VERIFIED LIFETIMES ARE A CONFLICT: unknown, neither picked, and every event refused (C4)", () => {
  const h = host(homeWith([record(L1, 41), record(L2, 42)]), { 41: running(WRITTEN - 5), 42: running(WRITTEN - 7) });
  h.boot();
  assert.deepEqual(word(h.current("lead", RESIDENT)), ["unknown", "conflict"]);
  assert.equal(h.current("lead", RESIDENT).lifetime, null);
  assert.deepEqual(h.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: NOW }), { applied: false, reason: "conflict", lifetime: undefined });
});

test("AN APPLIED EVENT IS DURABLE: a new host on the same home restores it; a refused one writes nothing", () => {
  const home = homeWith([record(L1, 41)]);
  const answers = { 41: running(WRITTEN - 5) };
  const first = host(home, answers);
  first.boot();
  assert.equal(first.applyEvent({ agentId: "lead", lifetime: "", kind: "turn-start", firedAtUs: NOW }).reason, "unbound");
  assert.equal(fs.existsSync(turnsFile(home, "default")), false, "a refused event wrote nothing");
  first.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: NOW - 100 });
  const second = host(home, answers);
  second.boot();
  assert.deepEqual(word(second.current("lead", RESIDENT)), ["working", "turn-open"]);
  assert.equal(second.current("lead", RESIDENT).turn.startedAtUs, NOW - 100);
});

test("AN AGENT WITH NO RECORD is offline, and one whose given facts are missing is unknown (fails closed)", () => {
  const h = host(homeWith([]), {});
  h.boot();
  assert.deepEqual(word(h.current("nobody", RESIDENT)), ["offline", "absent"]);
  assert.deepEqual(word(h.current("nobody", { mode: "resident" })), ["unknown", "unrecognised"]);
});
