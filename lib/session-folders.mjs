// Each agent's session folder, ~/.aify/sessions/<agent id>/, and when this host removes it.
//
// THE LAUNCHER WRITES IT (aify-wrapper lib/session-folder.mjs): the agent's --mcp-config (which can hold keys) and its
// instructions, rewritten at every launch, in a folder only its owner can open. A kill leaves it behind, so nothing
// the launcher does removes it. This does, for an agent this host no longer defines.
//
// NEVER UNDER A RUNNING AGENT. Removing a definition does not stop its agent (DefinitionStore only moves the file to
// .trash; the next start is refused), and its claude keeps reading that folder: with --system-prompt-snapshot off it
// is ASSUMED to re-read its instructions there on a rebuild. So the rule, approved 2026-10-28: remove the folder only
// when the agent has NO DEFINITION here AND this host's identity says NO LIVE PROCESS. Anything unknown keeps it; a
// kept folder is owner-only and holds what the next launch rewrites anyway.
//
// EVENTS, NOT TIME (the operator's rule). It is asked when a definition is removed, when an agent's last lifetime
// ends, and once when the daemon starts, for folders left while no aify-env was running. Nothing polls.
//
// A FOLDER NOBODY NAMED (`_pid-<pid>`) IS THE LAUNCHER'S: it records its own launcher and sweeps its own. This never
// touches a name an agent id cannot be.

import fs from "node:fs";
import path from "node:path";

//: An agent id, as the store and the launcher both spell it: plain, so it cannot climb out of the sessions folder.
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Where every agent's session folder lives: the launcher's `sessionsRoot`, spelled once on this side. The home is
 * REQUIRED: a default would be the operator's real home wherever a caller forgot to pass its own, and the daemon's
 * start walks this folder removing things.
 */
export function sessionsRoot(home) {
  if (typeof home !== "string" || !home) throw new TypeError("sessionsRoot needs the home it is under");
  return path.join(home, ".aify", "sessions");
}

/**
 * What `aify-env agents remove` says about the agent's session folder, from the running aify-env's answer, or ""
 * when there is nothing to say. PURE.
 * @param {string} agentId
 * @param {{removed?: boolean, reason?: string, problem?: string}} answer
 * @param {boolean} present whether the folder exists, for an answer that never came
 */
export function sessionFolderLine(agentId, answer, present) {
  if (answer?.problem) {
    return present ? `its session folder stays: no aify-env answered (${answer.problem}); `
      + `the next aify-env start removes it if ${agentId} is not running then` : "";
  }
  if (answer?.removed) return "its session folder was removed";
  if (answer?.reason === "absent") return "";
  if (answer?.reason === "running") return `its session folder stays while ${agentId} runs; aify-env removes it when ${agentId} stops`;
  return `its session folder stays (${answer?.reason || "no reason given"})`;
}

/**
 * Whether an agent's session folder may go. PURE.
 * @param {{defined: boolean|null, identity: {current?: object|null, conflict?: boolean, unknown?: boolean}|null}} facts
 *   `defined` null when the definitions could not be read whole; `identity` null when it could not be asked
 * @returns {{remove: boolean, reason: "defined"|"definitions-unknown"|"identity-unknown"|"running"|"not-running"}}
 */
export function sessionFolderVerdict({ defined, identity }) {
  if (defined === true) return { remove: false, reason: "defined" };
  if (defined !== false) return { remove: false, reason: "definitions-unknown" };
  if (!identity || identity.unknown || identity.conflict) return { remove: false, reason: "identity-unknown" };
  if (identity.current) return { remove: false, reason: "running" };
  return { remove: true, reason: "not-running" };
}

/**
 * Whether `agentId` is defined, from a `DefinitionStore.list()` answer: true, false, or null when the answer is
 * partial and does not name it (an unreadable file may be its definition). PURE.
 */
export function definedIn(listed, agentId) {
  if (!Array.isArray(listed?.definitions)) return null;
  if (listed.definitions.some((reading) => reading?.id === agentId)) return true;
  return listed.unreadable?.length || listed.conflict || listed.enumerationFailed ? null : false;
}

export class SessionFolders {
  #root;
  #definitions;
  #identity;
  #report;
  #fs;

  /**
   * @param {{root: string, definitions: {list: () => Promise<object>}, identity: (agentId: string) => object|Promise<object>,
   *   report?: (line: string) => void, files?: {readdirSync: Function, existsSync: Function, rmSync: Function}}} deps
   *   `identity` is the daemon's composed one (managed and residents), the one a stop is checked against
   */
  constructor({ root, definitions, identity, report = () => {}, files = fs }) {
    this.#root = root;
    this.#definitions = definitions;
    this.#identity = identity;
    this.#report = report;
    this.#fs = files;
  }

  /**
   * Remove `agentId`'s folder if the rule allows it now.
   * @returns {Promise<{agentId: string, removed: boolean, reason: string}>} `reason` "absent" when there is no folder
   */
  async forget(agentId) {
    const id = String(agentId ?? "");
    if (!AGENT_ID.test(id)) return { agentId: id, removed: false, reason: "not-an-agent-id" };
    const dir = path.join(this.#root, id);
    if (!this.#fs.existsSync(dir)) return { agentId: id, removed: false, reason: "absent" };
    let defined = null;
    try { defined = definedIn(await this.#definitions.list(), id); } catch { defined = null; }
    let identity = null;
    try { identity = await this.#identity(id); } catch { identity = null; }
    const verdict = sessionFolderVerdict({ defined, identity });
    if (!verdict.remove) return { agentId: id, removed: false, reason: verdict.reason };
    this.#fs.rmSync(dir, { recursive: true, force: true });
    this.#report(`session folder of ${id} removed: it is not defined here and not running`);
    return { agentId: id, removed: true, reason: verdict.reason };
  }

  /** `forget` for an event raised inside a refresh: run after it returns, with any failure reported, never thrown. */
  notice(agentId) {
    setImmediate(() => {
      this.forget(agentId).catch((error) => this.#report(`session folder of ${agentId}: ${error?.message || error}`));
    });
  }

  /** `forget` for every folder an agent id names: the daemon's start, for what was left while none ran. */
  async reconcile() {
    let entries;
    try { entries = this.#fs.readdirSync(this.#root, { withFileTypes: true }); } catch { return []; }
    const results = [];
    for (const entry of entries.filter((dirent) => dirent.isDirectory() && AGENT_ID.test(dirent.name))) {
      results.push(await this.forget(entry.name));
    }
    return results;
  }
}
