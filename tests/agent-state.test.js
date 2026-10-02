// The one derivation of an agent's state (lib/agent-state.mjs; 0.9 P0 C3). The turn law runs the shared table in
// tests/fixtures/agent-state-law.json, which aify-comms also runs through the Python it replaces.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { deriveAgentState, STRICT_TURN_MS, turnIsStillLive } from "../lib/agent-state.mjs";

const LAW = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-state-law.json", import.meta.url), "utf8"));
const at = (ago) => (ago === null ? 0 : (LAW.now - ago) * 1000);

test("THE TURN LAW agrees with the shared table, case by case", () => {
  assert.equal(STRICT_TURN_MS, LAW.strictSeconds * 1000, "the window is aify-comms' 30 minutes");
  assert.ok(LAW.turnLaw.length >= 15, "the table is the one aify-comms runs too");
  for (const row of LAW.turnLaw) {
    const live = turnIsStillLive({ startedAt: at(row.startedAgo), touchedAt: at(row.touchedAgo), renewable: row.renewable,
      now: LAW.now * 1000 });
    assert.equal(live, row.live, row.name);
  }
});

const base = { stoppedByOperator: false, definition: "valid", mode: "managed", process: "running", verified: "yes",
  startingInWindow: false, conflict: false, busy: false, awaitingInput: false, screen: null, backgroundShells: 0 };
const derive = (over) => deriveAgentState({ ...base, ...over });
const fresh = (state) => ({ state, fresh: true });

test("THE WORD follows C3's table, first match wins", () => {
  const cases = [
    [{ stoppedByOperator: true, conflict: true, busy: true }, "stopped", "operator-stop"],
    [{ conflict: true, busy: true }, "unknown", "conflict"],
    [{ definition: "invalid", process: "none" }, "misconfigured", "config"],
    [{ definition: "unavailable", process: "none" }, "misconfigured", "config"],
    [{ definition: "invalid" }, "idle", "at-prompt"],
    [{ definition: "invalid", verified: "unknown" }, "unknown", "identity-unknown"],
    [{ definition: "unavailable", process: "unknown" }, "unknown", "identity-unknown"],
    [{ definition: "invalid", verified: "no" }, "misconfigured", "config"],
    [{ process: "unknown" }, "unknown", "identity-unknown"],
    [{ verified: "unknown", busy: true }, "unknown", "identity-unknown"],
    [{ screen: fresh("working") }, "working", "screen"],
    [{ screen: fresh("blocked") }, "blocked", "screen"],
    [{ busy: true }, "working", "turn-open"],
    [{ busy: true, awaitingInput: true }, "blocked", "turn-open"],
    [{ busy: true, screen: fresh("idle") }, "working", "turn-open"],
    [{ busy: true, screen: fresh("shell") }, "working", "turn-open"],
    [{ screen: fresh("shell") }, "shell", "at-prompt"],
    [{ backgroundShells: 2 }, "shell", "at-prompt"],
    [{ screen: fresh("idle") }, "idle", "at-prompt"],
    [{ screen: { state: "working", fresh: false } }, "idle", "at-prompt"],
    [{}, "idle", "at-prompt"],
    [{ process: "starting", verified: "no", startingInWindow: true }, "starting", "starting"],
    [{ process: "starting", verified: "no", startingInWindow: false }, "available", "startable"],
    [{ process: "none", verified: "no" }, "available", "startable"],
    [{ process: "exited", verified: "no" }, "available", "startable"],
    [{ process: "none", verified: "no", mode: "resident" }, "offline", "absent"],
    [{ process: "none", verified: "no", definition: "none" }, "offline", "absent"],
    [{ process: "running", verified: "no" }, "available", "startable"],
    [{ process: "exited", verified: "no", startingInWindow: true }, "available", "startable"],
    [{ busy: true, awaitingInput: true, screen: fresh("idle") }, "blocked", "turn-open"],
    [{ conflict: true, process: "none", verified: "no" }, "unknown", "conflict"],
  ];
  for (const [over, state, cause] of cases) {
    assert.deepEqual(derive(over), { state, cause }, JSON.stringify(over));
  }
});

test("AN UNRECOGNISED FACT decides nothing: it is unknown, never a startable or offline agent", () => {
  for (const over of [{ verified: undefined }, { verified: "maybe" }, { process: "Running" }, { process: undefined },
    { definition: undefined }, { mode: "remote" }, { busy: undefined }, { stoppedByOperator: 1 }, { backgroundShells: -1 },
    { backgroundShells: 1.5 }, { screen: undefined }, { screen: { state: "idle" } }]) {
    assert.deepEqual(derive(over), { state: "unknown", cause: "unrecognised" }, JSON.stringify(over));
  }
  assert.deepEqual(derive({ verified: "yes", backgroundShells: 1 }), { state: "shell", cause: "at-prompt" },
    "CONTROL: one background shell is a recognised fact, and a shell");
  assert.deepEqual(deriveAgentState(null), { state: "unknown", cause: "unrecognised" });
});
