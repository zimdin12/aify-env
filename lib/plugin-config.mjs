// One plugin's own section of ~/.aify/config.json: `plugins["<registry name>"]`.
//
// THE HOST HANDS EACH PLUGIN ITS SECTION WITHOUT KNOWING WHAT IS IN IT. `pluginsForServices` binds a reader to
// each plugin's registry name, so the next plugin's settings need no change here, and no service is named.
//
// IT DECIDES NOTHING ABOUT THE KEYS. Whether a value is a grant, a preference or a path is the plugin's to judge,
// and a plugin that treats one as an execution grant fails closed on it there. This only says whether there is a
// section, and why not.
//
// Read on every call, so an edited file reaches a running plugin without a restart.

import fs from "node:fs";

import { hostConfigPath } from "./host-config.mjs";

/**
 * A plugin's section from the config file's text. PURE.
 *
 * ABSENT IS NOT BROKEN, and a plugin that defaults a setting on needs to tell them apart: `absent: true` says nobody
 * wrote a section (no file, an empty one, or no entry for this plugin), so its defaults stand; without it the file
 * was written and cannot be read as one, and a plugin that types or runs something on a setting turns it off.
 *
 * @returns {{config: object|null, problem: string, absent?: true}} `problem` is "" when a section was read, else why
 *   there is none
 */
export function pluginConfigFrom(text, name) {
  if (typeof text !== "string" || !text.trim()) {
    return { config: null, problem: "~/.aify/config.json does not exist or is empty", absent: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: null, problem: "~/.aify/config.json is not JSON" };
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  const plugins = root?.plugins;
  const pluginsAbsent = root !== null && plugins === undefined;
  const pluginsReadable = plugins && typeof plugins === "object" && !Array.isArray(plugins);
  const section = pluginsReadable ? plugins[name] : undefined;
  if (section === undefined) {
    const missing = { config: null, problem: `~/.aify/config.json has no plugins["${name}"] section` };
    return pluginsAbsent || pluginsReadable ? { ...missing, absent: true } : missing;
  }
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { config: null, problem: `plugins["${name}"] in ~/.aify/config.json is not an object` };
  }
  return { config: section, problem: "" };
}

/** Read from disk. Never throws: an unreadable file has no section, and says so. */
export function readPluginConfig({ name, home, env = process.env, readFile = fs.readFileSync } = {}) {
  let text = null;
  try {
    text = readFile(hostConfigPath(home ?? (env.USERPROFILE || env.HOME || "")), "utf8");
  } catch (error) {
    // Only a file that is not there is absent. One that is there and cannot be read was written by somebody.
    if (error?.code !== "ENOENT") return { config: null, problem: `~/.aify/config.json could not be read: ${error?.code || error?.message || error}` };
    text = null;
  }
  return pluginConfigFrom(text, name);
}
