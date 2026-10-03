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
 * @returns {{config: object|null, problem: string}} `problem` is "" when a section was read, else why there is none
 */
export function pluginConfigFrom(text, name) {
  if (typeof text !== "string" || !text.trim()) return { config: null, problem: "~/.aify/config.json does not exist or is empty" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: null, problem: "~/.aify/config.json is not JSON" };
  }
  const plugins = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.plugins : undefined;
  const section = plugins && typeof plugins === "object" ? plugins[name] : undefined;
  if (section === undefined) return { config: null, problem: `~/.aify/config.json has no plugins["${name}"] section` };
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
  } catch {
    text = null;
  }
  return pluginConfigFrom(text, name);
}
