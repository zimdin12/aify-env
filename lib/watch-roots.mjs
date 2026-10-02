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
 * @returns {{roots: string[], problem: string}} `problem` is "" when the list was read, else why nothing is granted
 */
export function watchRootsFrom(text, platform = process.platform) {
  if (typeof text !== "string" || !text.trim()) return { roots: [], problem: "no watchRoots granted in ~/.aify/config.json" };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { roots: [], problem: "~/.aify/config.json is not JSON" }; }
  const list = parsed && typeof parsed === "object" ? parsed.watchRoots : undefined;
  if (list === undefined) return { roots: [], problem: "no watchRoots granted in ~/.aify/config.json" };
  if (!Array.isArray(list)) return { roots: [], problem: "watchRoots is not a list" };
  const roots = [];
  for (const entry of list) {
    const root = normalizeRoot(entry, platform);
    if (!root) return { roots: [], problem: `watchRoots entry ${JSON.stringify(entry)} is not an absolute path; nothing is granted` };
    if (!roots.includes(root)) roots.push(root);
  }
  return { roots, problem: roots.length ? "" : "watchRoots is empty" };
}

/** Whether `candidate` is one of `roots` or inside one, by whole path segments: `c:/docker` holds `c:/docker/x`, never `c:/dockerx`. */
export function withinWatchRoots(candidate, roots, platform = process.platform) {
  const target = normalizeRoot(candidate, platform);
  if (!target) return false;
  return roots.some((root) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/** Read from disk. Never throws: an unreadable file grants nothing. */
export function readWatchRoots({ home, env = process.env, readFile = fs.readFileSync, platform = process.platform } = {}) {
  let text = null;
  try { text = readFile(hostConfigPath(home ?? (env.USERPROFILE || env.HOME || "")), "utf8"); } catch { text = null; }
  return watchRootsFrom(text, platform);
}
