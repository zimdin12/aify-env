// Host-level preferences shared by the aify tiers: `~/.aify/config.json`.
//
// WHY A NEW FILE. `~/.aify` already holds the service REGISTRY (`services.json`), credentials and
// logs. The registry describes SERVICES -- an endpoint, a credential reference, the MCP entry -- and
// a transport preference is a property of this HOST, true for every service that attaches to a
// process here. aify-env itself had no configuration at all before this, only environment variables,
// which cannot be set once and meant for every launcher a host runs.
//
// FAIL OPEN, ALWAYS. A file that is missing, unreadable, not JSON, or JSON of the wrong shape yields
// the DEFAULTS. A host preference that refuses to load must never stop a daemon from starting or an
// operator from attaching -- the worst it may do is leave you on the older transport.
//
// PRECEDENCE, highest first: the environment, then the file, then the default. The environment wins
// because it is how one run is changed without editing a file every launcher reads, which is exactly
// what a bisect or a support question needs.

import fs from "node:fs";
import path from "node:path";

/** Every setting, its default, and the environment variable that overrides it. */
export const HOST_SETTINGS = Object.freeze({
  localSocket: Object.freeze({
    default: true,
    env: "AIFY_ENV_LOCAL_SOCKET",
    // Keystrokes over a named pipe or unix socket instead of one HTTP request per chunk. Measured on
    // Windows 2026-09-20: 0.024 ms against 0.33 ms per keystroke, and ordering comes from the stream.
    // HTTP stays the fallback, because WSL cannot open a Windows pipe and another PC cannot open
    // either: the socket is only ever an optimisation for a client on this host.
  }),
});

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/** A flag as the environment states it, or null when it says nothing usable. */
export function flagFromEnv(env, name) {
  const raw = String(env?.[name] ?? "").trim().toLowerCase();
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return null;
}

/**
 * The effective host config. PURE: hand it the file's text and an environment.
 *
 * @param {string|null} text contents of config.json, or null when there is no file
 * @param {object} env
 */
export function hostConfigFrom(text, env = {}) {
  let parsed = null;
  if (typeof text === "string" && text.trim()) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  const transport = parsed && typeof parsed === "object" && parsed.transport && typeof parsed.transport === "object"
    ? parsed.transport
    : {};
  const config = {};
  for (const [key, spec] of Object.entries(HOST_SETTINGS)) {
    const fromEnv = flagFromEnv(env, spec.env);
    const fromFile = typeof transport[key] === "boolean" ? transport[key] : null;
    config[key] = fromEnv ?? fromFile ?? spec.default;
    config[`${key}Source`] = fromEnv != null ? "env" : fromFile != null ? "file" : "default";
  }
  return config;
}

export function hostConfigPath(home = process.env.USERPROFILE || process.env.HOME || "") {
  return path.join(home, ".aify", "config.json");
}

/** Read it from disk. Never throws: an unreadable file is the same as no file. */
export function readHostConfig({ home, env = process.env, readFile = fs.readFileSync } = {}) {
  let text = null;
  try { text = readFile(hostConfigPath(home ?? (env.USERPROFILE || env.HOME || "")), "utf8"); } catch { text = null; }
  return hostConfigFrom(text, env);
}

/**
 * The file's content with one setting set, preserving everything else it holds.
 *
 * PRESERVING IS THE POINT: another tier may already own keys in this file, and an installer that
 * rewrites it wholesale would delete them. Same rule the service registry follows.
 */
export function withHostSetting(text, key, value) {
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const transport = base.transport && typeof base.transport === "object" ? base.transport : {};
  // THE VERSION IS WHOEVER GOT HERE FIRST'S. Writing `version: 1` unconditionally overwrote it,
  // inside the one function whose whole purpose is to leave other tiers' keys alone -- so a file
  // another tier had stamped `2` came back as `1` the moment an operator reinstalled aify-env
  // (external review 2026-09-21, finding F). It is only stamped when nobody has stamped one.
  const version = "version" in base ? base.version : 1;
  return `${JSON.stringify({ ...base, version, transport: { ...transport, [key]: value } }, null, 2)}\n`;
}
