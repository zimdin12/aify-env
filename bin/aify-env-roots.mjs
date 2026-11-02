#!/usr/bin/env node
/**
 * `aify-env roots`: the folders this host starts managed agents in, besides the one aify-env was started in.
 *
 * THE ONLY WRITER of ~/.aify/launch-roots.json (lib/launch-roots.mjs). Local by design: no service and no HTTP route
 * can add a root, so nothing remote can widen where this host starts processes. A running aify-env new enough to read
 * the file picks a change up at its next spawn; this command asks it afterwards and says whether it did.
 */

import fs from "node:fs";
import process from "node:process";
import { homedir } from "node:os";

import { findEnvEndpoint } from "../lib/serving-endpoint.mjs";
import { workspaceWithinRoots } from "../lib/workspace-roots.mjs";
import {
  launchRootsFrom, launchRootsPath, parseLaunchRoot, readLaunchRootsFile, withLaunchRootAdded, withLaunchRootRemoved,
  writeLaunchRootsFile,
} from "../lib/launch-roots.mjs";

export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_FAILED = 65;
const USAGE = "usage: aify-env roots list | add <folder> | remove <folder>";

/**
 * Run one verb. I/O through `io` and `running`, so a test drives it on a fixture file.
 * @param {string[]} argv  the words after `roots`
 * @param {{file: string, windows: boolean, io?: typeof fs, running?: () => Promise<object|null>}} deps
 *   `running` answers the live aify-env's /health body, or null when none answered
 * @returns {Promise<{code: number, lines: string[]}>}
 */
export async function runRoots(argv, { file, windows, io = fs, running = async () => null }) {
  const [verb, folder, ...extra] = argv;
  if (verb === "list" && folder === undefined) return list({ file, windows, io, running });
  if ((verb === "add" || verb === "remove") && folder !== undefined && !extra.length) {
    const read = parseLaunchRoot(folder, { windows });
    if (read.refused) return { code: EXIT_USAGE, lines: [`aify-env roots: ${read.refused}`] };
    const stored = storedRoots(file, windows, io);
    if (stored.problem) {
      return { code: EXIT_FAILED, lines: [`aify-env roots: ${file} is not written over: it is ignored because ${stored.problem}; correct or delete it`] };
    }
    return verb === "add"
      ? add(read.root, stored.roots, { file, windows, io, running })
      : remove(read.root, stored.roots, { file, windows, io });
  }
  return { code: EXIT_USAGE, lines: [USAGE] };
}

/** The stored roots, or why the file counts for none. */
function storedRoots(file, windows, io) {
  const text = readLaunchRootsFile(file, io);
  return text.problem ? { roots: [], problem: text.problem } : launchRootsFrom(text.text, { windows });
}

async function list({ file, windows, io, running }) {
  const stored = storedRoots(file, windows, io);
  const lines = [...await liveLines(running), `added on this host (${file}):`];
  if (stored.problem) lines.push(`  none count: the file is ignored because ${stored.problem}`);
  else lines.push(...(stored.roots.length ? stored.roots.map((root) => `  ${root}`) : ["  none"]));
  return { code: stored.problem ? EXIT_FAILED : EXIT_OK, lines };
}

async function add(root, stored, { file, windows, io, running }) {
  const changed = withLaunchRootAdded(stored, root, { windows });
  if (changed.already) return { code: EXIT_OK, lines: [`already a launch root: ${changed.already}`] };
  let stat = null;
  try { stat = io.statSync(root); } catch { stat = null; }
  if (!stat?.isDirectory()) return { code: EXIT_FAILED, lines: [`aify-env roots: ${root} is not a folder on this host`] };
  writeLaunchRootsFile(file, changed.roots, io);
  const lines = [`stored ${root}`];
  const wider = stored.find((other) => workspaceWithinRoots(root, [other], { windows }));
  if (wider) lines.push(`(it is inside ${wider}, which already covers it)`);
  return { code: EXIT_OK, lines: [...lines, await inForce(root, windows, running)] };
}

function remove(root, stored, { file, windows, io }) {
  const changed = withLaunchRootRemoved(stored, root, { windows });
  if (!changed.removed) {
    return { code: EXIT_FAILED, lines: [`aify-env roots: ${root} is not an added launch root; added: ${stored.join(", ") || "none"}`] };
  }
  writeLaunchRootsFile(file, changed.roots, io);
  return { code: EXIT_OK, lines: [`removed ${changed.removed}`,
    "agents already running under it keep running; their next start there is refused"] };
}

/** What the live aify-env says it starts work under. */
async function liveLines(running) {
  const health = await running();
  if (!health) return ["no aify-env answered; it starts work under the folder it is started in, plus the roots below"];
  if (!Array.isArray(health.cwdRoots)) return ["the running aify-env does not report where it starts work"];
  const note = health.launchRootsFile ? "" : " (it is older than added roots: they count after one ordinary restart)";
  return [`the running aify-env starts work under: ${health.cwdRoots.join(", ")}${note}`];
}

/** Read back from the live aify-env whether the new root is in force there. */
async function inForce(root, windows, running) {
  const health = await running();
  if (!health) return "no aify-env answered; it counts from the next start";
  if (!health.launchRootsFile) return "the running aify-env is older than added roots: it counts after one ordinary restart";
  if (health.launchRootsFile.problem) return `the running aify-env ignores the file: ${health.launchRootsFile.problem}`;
  const roots = Array.isArray(health.cwdRoots) ? health.cwdRoots : [];
  return workspaceWithinRoots(root, roots, { windows }) ? "in force now in the running aify-env"
    : `the running aify-env does not report it yet; it reports ${roots.join(", ") || "nothing"}`;
}

/** The live aify-env's /health body, or null. */
async function liveHealth() {
  const found = await findEnvEndpoint();
  if (found.problem || !found.endpoint) return null;
  try {
    const response = await fetch(`${found.endpoint}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const answer = await runRoots(process.argv.slice(2), { file: launchRootsPath(homedir()), windows: process.platform === "win32",
    running: liveHealth });
  (answer.code === EXIT_OK ? process.stdout : process.stderr).write(answer.lines.join("\n") + "\n");
  process.exitCode = answer.code;
}

if (process.argv[1] && /aify-env-roots\.mjs$/.test(process.argv[1])) await main();
