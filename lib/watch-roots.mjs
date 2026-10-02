// The folders a plugin may READ on this host: `watchRoots` in `~/.aify/config.json`.
//
// A GRANT, SO IT FAILS CLOSED. The host settings beside it (lib/host-config.mjs) fail open to their defaults, which
// is right for a transport preference and wrong here: a missing, unreadable or malformed list grants nothing, and an
// invalid entry refuses the whole list rather than granting the rest of it. The default is no roots, never the
// daemon's working directory, which is only where it happened to start.
//
// NO ENVIRONMENT OVERRIDE. A variable a child inherits must not be able to widen what the host lets a service read.
//
// Read on every call, so a grant edited into the file reaches a running plugin without a restart.

import fs from "node:fs";
import path from "node:path";

import { hostConfigPath } from "./host-config.mjs";

/** One spelling per folder: forward slashes, no trailing slash, case-folded where the filesystem folds case. */
function normalizeRoot(value, platform = process.platform) {
  const windows = platform === "win32";
  const flavour = windows ? path.win32 : path.posix;
  if (typeof value !== "string" || !value.trim() || !flavour.isAbsolute(value.trim())) return null;
  let normal = flavour.normalize(value.trim()).split(String.fromCharCode(92)).join("/");
  if (windows && !/^[a-zA-Z]:\//.test(normal)) return null;  // a drive path, not `/x` or a UNC share
  if (normal.length > 1 && normal.endsWith("/") && !/^[a-zA-Z]:\/$/.test(normal)) normal = normal.slice(0, -1);
  return windows ? normal.toLowerCase() : normal;
}

/**
 * The granted roots from the config file's text. PURE.
 *
 * @returns {{roots: string[], problem: string}} `problem` is "" unless the file or the list is malformed: no list is no grant, not a fault
 */
export function watchRootsFrom(text, platform = process.platform) {
  if (typeof text !== "string" || !text.trim()) return { roots: [], problem: "" };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { roots: [], problem: "~/.aify/config.json is not JSON" }; }
  const list = parsed && typeof parsed === "object" ? parsed.watchRoots : undefined;
  if (list === undefined) return { roots: [], problem: "" };
  if (!Array.isArray(list)) return { roots: [], problem: "watchRoots is not a list" };
  const roots = [];
  for (const entry of list) {
    const root = normalizeRoot(entry, platform);
    if (!root) return { roots: [], problem: `watchRoots entry ${JSON.stringify(entry)} is not an absolute path; nothing is granted` };
    if (!roots.includes(root)) roots.push(root);
  }
  return { roots, problem: "" };
}

/** Whether `candidate` is one of `roots` or inside one, by whole path segments: `c:/docker` holds `c:/docker/x`, never `c:/dockerx`. */
export function withinWatchRoots(candidate, roots, platform = process.platform) {
  const target = normalizeRoot(candidate, platform);
  if (!target) return false;
  return roots.some((root) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/**
 * Everything granted: each VALID agent definition's workspace, plus the explicit list. PURE.
 *
 * A defined agent's workspace is a folder the operator already chose for it, and definitions are operator-protected,
 * so where an agent works is where its project is read (the operator, 2026-10-02). An invalid definition grants
 * nothing; a workspace that is not an absolute path is skipped and named. The explicit list keeps its own rule (one
 * invalid entry voids the list) without voiding the workspaces. `problems` lists what granted nothing, beside
 * whatever did.
 *
 * @param {{roots: string[], problem: string}} listed  watchRootsFrom's answer
 * @param {Array<{id: string, problems: string[], agent?: {workspace?: string}}>|null} readings  null = unreadable
 * @returns {{roots: string[], problems: string[]}}
 */
export function grantedRoots(listed, readings, platform = process.platform) {
  const roots = [...listed.roots];
  const problems = listed.problem ? [listed.problem] : [];
  if (readings === null) problems.push("agent definitions are unreadable, so no workspace is granted");
  for (const reading of readings ?? []) {
    if (reading.problems?.length || !reading.agent) continue;
    const root = normalizeRoot(reading.agent.workspace, platform);
    if (!root) { problems.push(`agent ${reading.id}: workspace ${JSON.stringify(reading.agent.workspace ?? "")} is not an absolute path`); continue; }
    if (!roots.includes(root)) roots.push(root);
  }
  if (!roots.length && !problems.length) problems.push("nothing is granted: no agent is defined and watchRoots is empty");
  return { roots, problems };
}

/** The whole grant, read now: the config file and the definition store. Never throws. */
export async function readGrantedRoots({ definitions = null, ...options } = {}) {
  let readings = null;
  try { readings = definitions ? (await definitions.list()).definitions : []; } catch { readings = null; }
  return grantedRoots(readWatchRoots(options), readings, options.platform);
}

/** Read from disk. Never throws: an unreadable file grants nothing. */
export function readWatchRoots({ home, env = process.env, readFile = fs.readFileSync, platform = process.platform } = {}) {
  let text = null;
  try { text = readFile(hostConfigPath(home ?? (env.USERPROFILE || env.HOME || "")), "utf8"); } catch { text = null; }
  return watchRootsFrom(text, platform);
}
