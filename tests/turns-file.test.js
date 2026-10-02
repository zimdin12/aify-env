// Each lifetime's turn record on disk, and what a restart does with it (lib/turns-file.mjs, restoreTurns; P0 C3).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyTurnEvent, restoreTurns } from "../lib/turn-events.mjs";
import { readTurns, turnsFile, writeTurns } from "../lib/turns-file.mjs";

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-turns-"));
const L1 = "7f3c9e2a-0000-4000-8000-000000000001";
const L2 = "7f3c9e2a-0000-4000-8000-000000000002";
const L3 = "7f3c9e2a-0000-4000-8000-000000000003";
const open = { open: true, startedAtUs: 100, awaitingInput: false, lastEventAtUs: 200 };
const closed = { open: false, startedAtUs: 0, awaitingInput: false, lastEventAtUs: 300 };

test("THE TURNS THE EVENTS PRODUCED are the turns read back after a restart", () => {
  const file = turnsFile(home(), "default");
  assert.ok(file.endsWith(path.join("env", "default.turns.json")));
  assert.deepEqual(readTurns(file), { turns: {}, problem: "" }, "no file is a first boot: no turns, no problem");
  let turns = {};
  for (const event of [{ kind: "turn-start", firedAtUs: 100 }, { kind: "blocked", firedAtUs: 150 }]) {
    turns = applyTurnEvent(turns, { ...event, lifetime: L1 }, { current: { lifetime: L1 }, conflict: null, unknown: [] }).turns;
  }
  writeTurns(file, turns);
  assert.deepEqual(readTurns(file), { turns, problem: "" });
});

test("A FILE THAT CANNOT BE READ RESTORES NOTHING AND SAYS WHY, never reading as no turns", () => {
  const file = turnsFile(home(), "default");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [text, why] of [["{", /not JSON/], ["[]", /not an object/], ["null", /not an object/],
    [JSON.stringify({ [L1]: { ...open, open: "yes" } }), /true or false/], [JSON.stringify({ [L1]: { ...open, startedAtUs: 0 } }), /open turn with no start/],
    [JSON.stringify({ [L1]: { ...open, lastEventAtUs: -1 } }), /whole microseconds/], [JSON.stringify({ [L1]: { ...open, startedAtUs: 1.5 } }), /whole microseconds/],
    [JSON.stringify({ [L1]: 7 }), /not an object/]]) {
    fs.writeFileSync(file, text);
    const read = readTurns(file);
    assert.equal(read.turns, null, text);
    assert.match(read.problem, why, text);
  }
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.deepEqual(readTurns(file, { readFile: () => { throw denied; } }), { turns: null, problem: "unreadable: EACCES" });
  fs.writeFileSync(file, JSON.stringify({ [L1]: open, [L2]: closed }));
  assert.deepEqual(readTurns(file).turns, { [L1]: open, [L2]: closed }, "CONTROL: a sound file with an open and a closed record");
});

test("A DAMAGED RECORD IS NEVER SAVED, and the file keeps what it had", () => {
  const file = turnsFile(home(), "default");
  writeTurns(file, { [L1]: open });
  assert.throws(() => writeTurns(file, { [L1]: { ...open, startedAtUs: 0 } }), /damaged turn record/);
  assert.deepEqual(readTurns(file).turns, { [L1]: open });
});

test("A RESTART keeps a yes lifetime's turn renewable, a no lifetime's turn gone, and anything else kept strict", () => {
  const verdicts = { [L1]: "yes", [L2]: "no" };
  const restored = restoreTurns({ [L1]: open, [L2]: open, [L3]: closed }, (lifetime) => verdicts[lifetime]);
  assert.deepEqual(restored.turns, { [L1]: open, [L3]: closed });
  assert.deepEqual([...restored.renewable], [L1], "only the verified lifetime renews");
  assert.deepEqual(restored.ended, [L2]);
  const odd = restoreTurns({ [L1]: open }, () => "maybe");
  assert.deepEqual([odd.turns, [...odd.renewable], odd.ended], [{ [L1]: open }, [], []], "a verdict it does not know is unknown");
});
