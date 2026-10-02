// Each lifetime's turn record, kept on disk so a restarted instance does not forget a turn in progress (0.9 P0 C3).
//
// `~/.aify/env/<instance>.turns.json` is an object keyed by lifetime, each value the record `applyTurnEvent` keeps:
// {open, startedAtUs, awaitingInput, lastEventAtUs}. A closed turn's record stays, because its last event orders the
// next one. What a restart does with each record is `restoreTurns` (lib/turn-events.mjs), by C4's verdict now.
//
// A FILE THAT CANNOT BE READ RESTORES NOTHING AND SAYS SO. It is not an empty file: forgetting an open turn reads an
// agent as idle while it works, so an unreadable or damaged file is a `problem`, and the caller treats every agent of
// the instance as not knowing its turn (C3: unknown until its next hook). A missing file is a first boot: no turns.

import fs from "node:fs";
import path from "node:path";

import { writeFileDurably } from "./durable-file.mjs";
import { instanceFile } from "./instance-files.mjs";

/** Where an instance's turns live. */
export function turnsFile(aifyHome, instance) {
  return instanceFile(aifyHome, instance, "turns.json");
}

const isMicros = (value) => Number.isSafeInteger(value) && value >= 0;

function turnProblem(lifetime, turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return `${lifetime}: not an object`;
  if (typeof turn.open !== "boolean" || typeof turn.awaitingInput !== "boolean") return `${lifetime}: open and awaitingInput must be true or false`;
  if (!isMicros(turn.startedAtUs) || !isMicros(turn.lastEventAtUs)) return `${lifetime}: times must be whole microseconds`;
  if (turn.open && turn.startedAtUs === 0) return `${lifetime}: an open turn with no start`;
  return "";
}

/**
 * @returns {{turns: Record<string, object>|null, problem: string}} turns, or null with the reason none were read
 */
export function readTurns(file, { readFile = fs.readFileSync } = {}) {
  let text;
  try {
    text = String(readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { turns: {}, problem: "" };
    return { turns: null, problem: `unreadable: ${error?.code || error?.message || error}` };
  }
  let body;
  try { body = JSON.parse(text); } catch { return { turns: null, problem: "not JSON" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { turns: null, problem: "not an object" };
  for (const [lifetime, turn] of Object.entries(body)) {
    const problem = turnProblem(lifetime, turn);
    if (problem) return { turns: null, problem };
  }
  return { turns: body, problem: "" };
}

/** Save the turns durably. Throws when it cannot: a caller that keeps running on an unsaved turn should know. */
export function writeTurns(file, turns, { write = writeFileDurably } = {}) {
  for (const [lifetime, turn] of Object.entries(turns)) {
    const problem = turnProblem(lifetime, turn);
    if (problem) throw new TypeError(`refusing to save a damaged turn record: ${problem}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(file, `${JSON.stringify(turns, null, 2)}\n`);
}
