// Which of the folders aify-dashboard names this host may read. Pure: inputs in, a decision out.
//
// THE SERVICE NAMES FOLDERS; THE HOST DECIDES. A watch list is a request from another program, and a
// host that read whatever it was sent would let any holder of the dashboard's key make it walk an
// arbitrary path. So every listed folder passes three tests here before anything touches it: it is in
// this daemon's own namespace, it is inside a granted root (a defined agent's workspace, or a folder
// in `watchRoots`), and it is
// within the limit. Containment is aify-env's own `withinWatchRoots`, so this host has one definition
// of "inside a grant", not two that can drift. Each refusal is kept with its reason, because a folder
// dropped in silence reads on the dashboard as a project with no commits.

import { withinWatchRoots } from "../../watch-roots.mjs";

/** How many folders one plugin watches. Agreed with aify-env's owner; the rest are refused by name. */
export const MAX_LOCATIONS = 200;

/** How a namespace's paths compare, as the `platform` that `withinWatchRoots` takes. */
export const PLATFORM_OF = Object.freeze({ windows: "win32" });

/**
 * The host key aify-dashboard files this machine under: what follows the first colon of the machine
 * id, lowercased.
 *
 * LOWERCASED HERE AS WELL AS IN `machineIdFor`, because the dashboard refuses a mixed-case key with a
 * 400 rather than matching it, and a refusal on every refresh would leave this host watching nothing.
 *
 * @returns {string} the key, or "" when the machine id has nothing after a colon
 */
export function hostKeyOf(machineId) {
  const text = String(machineId || "");
  const colon = text.indexOf(":");
  return colon === -1 ? "" : text.slice(colon + 1).trim().toLowerCase();
}

/**
 * The namespace whose folders this daemon can read, or null when it serves none yet.
 *
 * ONLY WINDOWS, FOR NOW, and that is the dashboard's limit, not this host's: its head report resolves
 * Windows paths only. A WSL daemon shares the Windows side's host key and is sent the same list, so it
 * refuses every entry rather than report a Windows folder a second time through `/mnt/c`.
 */
export function namespaceOf(machineId) {
  return String(machineId || "").toLowerCase().startsWith("win32:") ? "windows" : null;
}

/**
 * The dashboard's answer, checked field by field.
 *
 * A MALFORMED LIST IS A FAILURE, NEVER AN EMPTY ONE. "Nothing to watch" and "could not tell what to
 * watch" look the same once they are an empty array, and the first would stop every report while the
 * plugin read as healthy.
 *
 * @returns {{ok: true, items: Array<{projectId: string, name: string, namespace: string, path: string}>} | {ok: false, problem: string}}
 */
export function parseWatchList(body, hostKey) {
  if (!body || typeof body !== "object" || !Array.isArray(body.projects)) {
    return { ok: false, problem: "the watch list is not an object with a projects array" };
  }
  if (body.hostKey !== hostKey) {
    return { ok: false, problem: `the watch list is for host "${String(body.hostKey)}", not "${hostKey}"` };
  }
  const items = [];
  for (const [index, project] of body.projects.entries()) {
    const root = project?.root;
    const fields = [project?.projectId, project?.name, root?.fsNamespace, root?.path];
    if (!fields.every((value) => typeof value === "string" && value !== "")) {
      return { ok: false, problem: `watch list entry ${index} is missing its project id, name, namespace or path` };
    }
    items.push({ projectId: project.projectId, name: project.name, namespace: root.fsNamespace, path: root.path });
  }
  return { ok: true, items };
}

/**
 * Split the listed folders into the ones this daemon watches and the ones it refuses, with a reason.
 *
 * NO ROOTS MEANS NOTHING IS READ. The grant fails closed: a host with no defined agent and no
 * `watchRoots` has granted nothing, and the refusal says the two ways to grant a folder.
 *
 * @param {object} grant
 * @param {string|null} grant.namespace  from `namespaceOf`
 * @param {string[]} grant.roots         the `roots` of `shared.watchRoots()`
 * @returns {{watch: Array<{projectId: string, name: string, path: string}>, refused: Array<{path: string, reason: string}>}}
 */
export function selectLocations(items, { namespace, roots }) {
  const watch = [];
  const refused = [];
  for (const item of items) {
    if (namespace === null || item.namespace !== namespace) {
      refused.push({ path: item.path, reason: `it is in the ${item.namespace} namespace, and this aify-env reads ${namespace ?? "none yet"}` });
    } else if (!withinWatchRoots(item.path, roots, PLATFORM_OF[namespace])) {
      refused.push({ path: item.path, reason: roots.length === 0
        ? "no folder is granted: define an agent that works in it, or add \"watchRoots\": [\"<a parent folder>\"] to ~/.aify/config.json"
        : `it is outside every granted folder (${roots.join(", ")}); define an agent that works in it, or add a parent of it to "watchRoots" in ~/.aify/config.json` });
    } else if (watch.length >= MAX_LOCATIONS) {
      refused.push({ path: item.path, reason: `more than ${MAX_LOCATIONS} folders are listed for this host` });
    } else {
      watch.push({ projectId: item.projectId, name: item.name, path: item.path });
    }
  }
  return { watch, refused };
}
