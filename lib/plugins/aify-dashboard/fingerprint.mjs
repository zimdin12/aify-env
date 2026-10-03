// Whether a folder's HEAD may have moved, answered by stat rather than by running git.
//
// A HEAD MOVES ONLY BY WRITING ONE OF THREE FILES: the git directory's `HEAD` (a checkout or a detach),
// the ref file it points at (a commit on the branch), or `packed-refs` (a pack or a fetch that rewrote
// it). A linked worktree keeps its own `HEAD` but shares its branch refs with the main checkout, so the
// ref file and `packed-refs` are read from the COMMON directory.
//
// NO fs.watch. It is unreliable on Windows and across WSL mounts, and a missed event is a commit that
// is never reported.
//
// The fingerprint is a string, so "did anything move" is one comparison, and HEAD's own text is part
// of it: a checkout to another branch whose ref file happens to have the same size and time still
// changes the fingerprint.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** One file's size and modification time, or "absent". */
function statPart(path, stat) {
  try {
    const found = stat(path);
    return `${found.size}:${found.mtimeMs}`;
  } catch {
    return "absent";
  }
}

/**
 * Which repository a watched folder is bound to, as cheaply as the fingerprint:
 * - the folder's real path, which moves when a junction is re-pointed;
 * - its `.git`: a linked worktree's file names its git directory, and a clone's directory has an identity that a
 *   replacement clone does not share;
 * - that git directory's `commondir`, which names where the shared branch refs live. A linked worktree re-pointed
 *   there keeps its `.git` file and its HEAD text, and reads its refs from somewhere else;
 * - the REAL paths of the git directory a `.git` file names and of the directory `commondir` names. A junction on the
 *   way to either can be re-pointed, outside the grant even, with every file above unchanged.
 *
 * The watcher keeps a folder's git directories while this holds, and resolves them again the moment it moves: a
 * folder rebound while the old repository sits untouched would otherwise keep reporting the old one's HEAD.
 */
export function bindingOf(location, { realpath = realpathSync.native, readFile = readFileSync, stat = statSync } = {}) {
  // Where a named directory really is: a junction on the way to it can be re-pointed while every name stays the same.
  const realOf = (path) => {
    try {
      return realpath(path);
    } catch {
      return "unresolved";
    }
  };
  const commonOf = (gitDir) => {
    let text;
    try {
      text = String(readFile(join(gitDir, "commondir"), "utf8")).trim();
    } catch {
      return "no commondir";
    }
    return `commondir ${text} at ${realOf(resolve(gitDir, text))}`;
  };
  let real;
  try {
    real = realpath(location);
  } catch {
    return "absent";
  }
  const dotGit = join(real, ".git");
  let found;
  try {
    found = stat(dotGit, { bigint: true });
  } catch {
    return `${real}|no .git`;
  }
  if (found.isDirectory()) return `${real}|dir ${found.dev}:${found.ino}:${found.birthtimeNs}|${commonOf(dotGit)}`;
  let text;
  try {
    text = String(readFile(dotGit, "utf8")).trim();
  } catch {
    return `${real}|unreadable .git`;
  }
  // `gitdir:` may be relative to the folder, as git writes it for some worktrees.
  const named = text.startsWith("gitdir:") ? resolve(real, text.slice("gitdir:".length).trim()) : "";
  return `${real}|file ${text}|${named ? `at ${realOf(named)}|${commonOf(named)}` : "no gitdir"}`;
}

/**
 * @param {{gitDir: string, commonDir: string}} dirs  from `GitReader.gitDirs`
 * @param {object} [fs]  injected so a test can show which files are looked at
 * @returns {string} changes whenever HEAD may have moved
 */
export function headFingerprint({ gitDir, commonDir }, { readFile = readFileSync, stat = statSync } = {}) {
  let headText;
  try {
    headText = String(readFile(join(gitDir, "HEAD"), "utf8")).trim();
  } catch {
    headText = "absent";
  }
  const ref = headText.startsWith("ref: ") ? headText.slice("ref: ".length).trim() : "";
  const parts = [
    `HEAD=${headText}`,
    `ref=${ref ? statPart(join(commonDir, ref), stat) : "detached"}`,
    `packed=${statPart(join(commonDir, "packed-refs"), stat)}`,
  ];
  return parts.join("|");
}
