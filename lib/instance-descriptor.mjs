// Where an instance listens, for the hooks of the agents it adopted (0.9 plan P0 C4, "Routing").
//
// `~/.aify/env/<instance>.json` is {url, instance, pid, startedAt}. A hook reads the file named by its
// `AIFY_ENV_INSTANCE` on every event, so a restarted instance on a new port is found without relaunching anybody.
//
// BESIDE `ready.json`, NOT INSTEAD OF IT. A `herdr-aify env` daemon's ready receipt is one per invocation, and finding
// the live one takes a scan and a /health probe (lib/serving-endpoint.mjs). This is one current pointer per instance
// name, cheap enough for a hook to read each time. A stale one needs no probe: an event it misdirects names a lifetime
// that instance has not adopted, and admission refuses it (`not-current`). It takes the receipts' loopback rule, so a
// file on disk can never aim a hook off this host.
//
// An instance writes its own at readiness and removes it on a clean exit only while it still names this pid, so an
// exiting predecessor never removes its successor's.

import fs from "node:fs";
import path from "node:path";

import { writeFileDurably } from "./durable-file.mjs";
import { instanceFile } from "./instance-files.mjs";
import { isLoopbackEndpoint } from "./serving-endpoint.mjs";

/** Where an instance's descriptor lives. */
export function descriptorFile(aifyHome, instance) {
  return instanceFile(aifyHome, instance, "json");
}

/**
 * A descriptor's text as a descriptor, or the reason it is not one.
 *
 * @returns {{ok: true, descriptor: {url: string, instance: string, pid: number, startedAt: string}} | {ok: false, problem: string}}
 */
export function parseDescriptor(text) {
  let body;
  try { body = JSON.parse(String(text ?? "")); } catch { return { ok: false, problem: "not JSON" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, problem: "not an object" };
  const { url, instance, pid, startedAt } = body;
  if (!isLoopbackEndpoint(url)) return { ok: false, problem: "url is not a loopback endpoint" };
  if (typeof instance !== "string" || !instance) return { ok: false, problem: "instance" };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, problem: "pid" };
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return { ok: false, problem: "startedAt" };
  return { ok: true, descriptor: { url, instance, pid, startedAt } };
}

/** Write this instance's descriptor durably. Refuses one it would itself refuse to read. */
export function writeDescriptor(file, descriptor, { write = writeFileDurably } = {}) {
  const text = `${JSON.stringify(descriptor)}\n`;
  const parsed = parseDescriptor(text);
  if (!parsed.ok) throw new TypeError(`refusing to write a descriptor: ${parsed.problem}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(file, text);
}

/**
 * Remove the descriptor only while it names `pid`: a successor's is left alone, and so is one this cannot read.
 *
 * @returns {boolean} whether it was removed
 */
export function removeOwnDescriptor(file, pid, { readFile = fs.readFileSync, rm = fs.rmSync } = {}) {
  let parsed;
  try { parsed = parseDescriptor(readFile(file, "utf8")); } catch { return false; }
  if (!parsed.ok || parsed.descriptor.pid !== pid) return false;
  rm(file, { force: true });
  return true;
}
