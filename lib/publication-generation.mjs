// The generation an instance publishes under, advanced and saved before its first push (0.9 plan P0 C5).
//
// `~/.aify/env/<instance>.generation` holds the last one as a decimal integer. Each boot takes
// max(saved + 1, now) and writes it durably BEFORE anything is published under it: a generation that was used but
// not saved could be used again after a crash, and a receiver would take the second boot's bodies as the first's.
// So a write that fails throws, and the caller publishes nothing. A file with no leading digits is a lost file,
// which the clock recovers on a host whose clock is sane (C5's one unrecoverable case is a lost file AND a clock
// behind it, which the receiver reports). A file that exists but cannot be read is not lost: it throws too.

import fs from "node:fs";
import path from "node:path";

import { nextGeneration } from "./agent-state-publisher.mjs";
import { writeFileDurably } from "./durable-file.mjs";

const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Where an instance's generation lives. The instance name becomes a file name, so it must be one. */
export function generationFile(aifyHome, instance) {
  if (typeof instance !== "string" || !INSTANCE.test(instance)) throw new TypeError(`not an instance name: ${JSON.stringify(instance)}`);
  return path.join(aifyHome, "env", `${instance}.generation`);
}

/**
 * Advance the saved generation and return the new one, saved.
 *
 * @param {string} file
 * @param {{nowMs?: number, readFile?: Function, write?: Function}} [io]
 * @returns {number}
 */
export function advanceGeneration(file, { nowMs = Date.now(), readFile = fs.readFileSync, write = writeFileDurably } = {}) {
  let saved = null;
  try {
    // The leading digits, when there are any: a value read too high only raises the next generation, which costs
    // nothing, while one discarded could let a clock behind it reuse a generation.
    const digits = /^[0-9]{1,16}/.exec(String(readFile(file, "utf8")).trim());
    if (digits) saved = Number(digits[0]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const generation = nextGeneration(saved, nowMs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(file, `${generation}\n`);
  return generation;
}
