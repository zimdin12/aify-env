// WHERE THIS HOST MAY START WORK: the folder aify-env was started in, plus the roots the operator added ON THIS HOST
// with `aify-env roots add` (~/.aify/launch-roots.json).
//
// WHY A HOST SETTING. One start folder can never cover C:\ and D:\, so an agent working on D:\ read misconfigured on
// a host started at C:\ (Steven's terraria-manager, 2026-11-02). The service's own `cwdRoots` is its policy and never
// reaches a launch: a service must not be able to widen where this host starts processes, so nothing here reads it.
//
// FAILS CLOSED. A file that cannot be read, is not this format, or holds any entry `parseLaunchRoot` refuses adds
// nothing: the roots are the start folder alone, never a partial list. Read at every ask, so an added root reaches the
// next spawn without a restart (once this code is the code running), and a file that became unreadable adds nothing.
//
// Containment stays lib/workspace-roots.mjs's: textual, slashes unified, case folded on Windows only.

import fs from "node:fs";
import path from "node:path";

export const LAUNCH_ROOTS_VERSION = 1;
const BACKSLASH = String.fromCharCode(92);

/** ~/.aify/launch-roots.json under `home`. */
export function launchRootsPath(home = process.env.USERPROFILE || process.env.HOME || "") {
  return path.join(home, ".aify", "launch-roots.json");
}

/**
 * One folder as typed, in its stored spelling (`D:\` -> `D:/`), or why it is refused. PURE.
 *
 * Refused, not resolved: a relative path, `~`, or a `.`/`..` segment would make the stored value something other
 * than what the operator typed. A bare `D:` is the drive root (lead ruling 2026-11-02); the command prints what it
 * stored so that reading is visible. UNC and device paths are refused until something needs them.
 * @returns {{root: string}|{refused: string}}
 */
export function parseLaunchRoot(text, { windows = false } = {}) {
  const typed = typeof text === "string" ? text.trim() : "";
  if (!typed) return { refused: "no folder given" };
  let root;
  if (windows) {
    const slashed = typed.split(BACKSLASH).join("/");
    if (slashed.startsWith("//")) return { refused: `${typed}: UNC and device paths are not supported yet` };
    const drive = /^([a-zA-Z]):(\/.*)?$/.exec(slashed);
    if (!drive) return { refused: `${typed}: not an absolute folder with a drive letter (D:${BACKSLASH}Games)` };
    root = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  } else {
    if (!typed.startsWith("/")) return { refused: `${typed}: not an absolute folder` };
    root = typed;
  }
  root = root.replace(/\/{2,}/g, "/");
  if (root.split("/").some((segment) => segment === "." || segment === "..")) {
    return { refused: `${typed}: names . or ..; give the folder itself` };
  }
  const top = windows ? /^[A-Z]:\/$/.test(root) : root === "/";
  return { root: top ? root : root.replace(/\/+$/, "") };
}

/** The comparison spelling: the guard's own (slashes unified, no trailing slash, case folded on Windows). PURE. */
function rootKey(root, windows) {
  const slashed = String(root).split(BACKSLASH).join("/").replace(/\/+$/, "");
  return windows ? slashed.toLowerCase() : slashed;
}

/** The first of `roots` with the same key as `root`, or "". PURE. */
function sameRoot(roots, root, windows) {
  return roots.find((each) => rootKey(each, windows) === rootKey(root, windows)) ?? "";
}

/**
 * The stored roots from the file's text, or why none count. PURE. Absent text is no roots and no problem.
 * @returns {{roots: string[], problem: string}}
 */
export function launchRootsFrom(text, { windows = false } = {}) {
  if (text == null) return { roots: [], problem: "" };
  const none = (problem) => ({ roots: [], problem });
  let parsed;
  try { parsed = JSON.parse(text); } catch { return none("it is not JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none("it is not an object");
  if (parsed.version !== LAUNCH_ROOTS_VERSION) return none(`its version is ${JSON.stringify(parsed.version)}, not ${LAUNCH_ROOTS_VERSION}`);
  if (!Array.isArray(parsed.roots)) return none("its roots are not a list");
  const roots = [];
  for (const entry of parsed.roots) {
    const read = parseLaunchRoot(entry, { windows });
    if (read.refused) return none(`entry ${JSON.stringify(entry)} is refused (${read.refused})`);
    if (!sameRoot(roots, read.root, windows)) roots.push(read.root);
  }
  return { roots, problem: "" };
}

/** The roots in force: the start folder first, as the process reports it, then each stored root it does not repeat. PURE. */
export function effectiveLaunchRoots(startFolder, stored, { windows = false } = {}) {
  const roots = [startFolder];
  for (const root of stored) if (!sameRoot(roots, root, windows)) roots.push(root);
  return roots;
}

/** The stored list with `root` added; `already` names the equal stored root when it was there. PURE. */
export function withLaunchRootAdded(stored, root, { windows = false } = {}) {
  const already = sameRoot(stored, root, windows);
  return { roots: already ? [...stored] : [...stored, root], already };
}

/** The stored list without `root`; `removed` is the stored spelling taken out, "" when it was not stored. PURE. */
export function withLaunchRootRemoved(stored, root, { windows = false } = {}) {
  const removed = sameRoot(stored, root, windows);
  return { roots: stored.filter((each) => each !== removed), removed };
}

/** The file's text for a stored list. PURE. */
export function launchRootsText(roots) {
  return `${JSON.stringify({ version: LAUNCH_ROOTS_VERSION, roots }, null, 2)}\n`;
}

/** Read the file: its text, null when absent, or the read failure as a problem. Never throws. */
export function readLaunchRootsFile(file, io = fs) {
  try { return { text: io.readFileSync(file, "utf8"), problem: "" }; }
  catch (error) { return error?.code === "ENOENT" ? { text: null, problem: "" } : { text: null, problem: `it cannot be read (${error?.code || error?.message || error})` }; }
}

/** Replace the file with this list: a sibling temporary file, then a rename, so a reader never sees half of it. */
export function writeLaunchRootsFile(file, roots, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  io.writeFileSync(temporary, launchRootsText(roots));
  io.renameSync(temporary, file);
}

/**
 * This daemon's launch roots: the start folder it was given and the host file, READ AT EVERY ASK. A stat-keyed cache
 * kept old roots for a file that became unreadable with the same time and size (review of e130408, R2), so the file
 * itself is read each time; only the parse and the log line wait for its text or its read failure to change.
 */
export class LaunchRoots {
  #start; #file; #windows; #io; #log; #seen = undefined; #answer = null;

  constructor({ startFolder, file, windows = process.platform === "win32", io = fs, log = () => {} }) {
    this.#start = startFolder; this.#file = file; this.#windows = windows; this.#io = io; this.#log = log;
  }

  /** The roots in force now. */
  current() { return this.read().roots; }

  /** `{roots, stored, problem, file}`: what is in force, what the file adds, and why it adds nothing when it does not. */
  read() {
    const file = readLaunchRootsFile(this.#file, this.#io);
    const seen = file.problem ? `problem:${file.problem}` : file.text === null ? "absent" : `text:${file.text}`;
    if (seen === this.#seen && this.#answer) return this.#answer;
    const parsed = file.problem ? { roots: [], problem: file.problem } : launchRootsFrom(file.text, { windows: this.#windows });
    this.#answer = { roots: effectiveLaunchRoots(this.#start, parsed.roots, { windows: this.#windows }),
      stored: parsed.roots, problem: parsed.problem, file: this.#file };
    this.#seen = seen;
    if (parsed.problem) this.#log(`launch roots: ${this.#file} is ignored because ${parsed.problem}; work starts only under ${this.#start}`);
    return this.#answer;
  }
}
