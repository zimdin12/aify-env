// The residents role's generation: read, advanced by one and saved durably by the holder, under the lock (B1 item 5).
//
// It orders successive holders on ONE publisher key: the receiver keeps the higher generation's rows and refuses a
// lower one as stale, so a successor supersedes a dead holder with no withdrawal (contract items 6 and 8). The lock
// serialises the writers, so each holder's generation is strictly above its predecessor's.
//
// IT NEVER GUESSES. Unlike an instance's own generation (lib/publication-generation.mjs), which recovers a lost file
// from the clock, a lost residents generation is not recoverable here: a predecessor may have published above any
// guess. So:
//   - a readable, valid file: that number plus one;
//   - a missing file in a genuinely fresh home (no residents descriptor, turns or `residents` record): the first
//     generation, from the clock, so a receiver that kept an older home's key still orders it above;
//   - a missing file while any of that residents state exists, or that state cannot be read: uncertain, no role;
//   - an unreadable, malformed, zero or exhausted file: no role.

import fs from "node:fs";
import path from "node:path";

import { writeFileDurably } from "./durable-file.mjs";
import { instanceFile } from "./instance-files.mjs";
import { parseLifetimeRecord } from "./resident-lifetimes.mjs";
import { RESIDENTS } from "./residents-home.mjs";

const RECORD_NAME = /^.+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/**
 * A generation file's text as the last generation, or the reason it is not one. Strict: digits, an optional final
 * newline, no leading zero, a safe integer with a successor.
 *
 * @returns {{ok: true, last: number} | {ok: false, reason: string}}
 */
export function parseGenerationText(text) {
  const match = /^([1-9][0-9]*)\r?\n?$/.exec(String(text));
  if (!match) return { ok: false, reason: "generation-invalid" };
  const last = Number(match[1]);
  if (!Number.isSafeInteger(last) || last >= Number.MAX_SAFE_INTEGER) return { ok: false, reason: "generation-exhausted" };
  return { ok: true, last };
}

/**
 * What residents state this home already holds, read as evidence for a missing generation file: anything found, or
 * anything that could not be read, makes initialising a guess.
 *
 * @returns {string[]} what was found or could not be read; empty only for a genuinely fresh home
 */
export function residentsStateEvidence(aifyHome, { io = fs } = {}) {
  const found = [];
  for (const extension of ["json", "turns.json"]) {
    const file = instanceFile(aifyHome, RESIDENTS, extension);
    try { io.statSync(file); found.push(path.basename(file)); }
    catch (error) { if (error?.code !== "ENOENT") found.push(`${path.basename(file)}: ${error?.code || "unreadable"}`); }
  }
  const dir = path.join(aifyHome, "residents");
  let names = [];
  try { names = io.readdirSync(dir); }
  catch (error) { if (error?.code !== "ENOENT") found.push(`residents/: ${error?.code || "unreadable"}`); }
  for (const name of names.filter((n) => RECORD_NAME.test(n))) {
    let text;
    try { text = io.readFileSync(path.join(dir, name), "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") found.push(`${name}: ${error?.code || "unreadable"}`); continue; }
    const parsed = parseLifetimeRecord(text, name);
    // A record that cannot be parsed may be a residents record: it counts.
    if (!parsed.ok) found.push(parsed.problem);
    else if (parsed.record.instance === RESIDENTS) found.push(`${name}: a ${RESIDENTS} record`);
  }
  return found;
}

/**
 * Take the next generation, saved before it is returned. Call only while holding the role's endpoint: `guard` runs
 * before the rename and throws to stop it, so a write cannot land after the lock moved.
 *
 * @returns {{ok: true, generation: number} | {ok: false, reason: string}}
 */
export function takeResidentsGeneration(aifyHome, { nowMs = Date.now(), guard = () => {}, io = fs, write = writeFileDurably } = {}) {
  const file = instanceFile(aifyHome, RESIDENTS, "generation");
  let next;
  let text = null;
  try { text = io.readFileSync(file, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") return { ok: false, reason: `generation-unreadable: ${error?.code || "error"}` }; }
  if (text === null) {
    const evidence = residentsStateEvidence(aifyHome, { io });
    if (evidence.length) return { ok: false, reason: `generation-missing-with-residents-state: ${evidence.join("; ")}` };
    next = Math.floor(nowMs);
    if (!Number.isSafeInteger(next) || next <= 0) return { ok: false, reason: "generation-clock-invalid" };
  } else {
    const parsed = parseGenerationText(text);
    if (!parsed.ok) return parsed;
    next = parsed.last + 1;
  }
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    write(file, `${next}\n`, { guard });
  } catch (error) {
    return { ok: false, reason: `generation-unwritable: ${error?.code || error?.message || "error"}` };
  }
  return { ok: true, generation: next };
}
