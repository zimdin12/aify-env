// What a git directory inside the grant holds must not lead out of it.
//
// THE GIT DIRECTORY BEING INSIDE IS NOT ENOUGH. With the working tree, the git directory and the shared one all inside
// the grant (grant-check.mjs), git still reads whatever is nested in them, and three ways out were measured on the
// first version of that check (aify-dashboard docs/evidence/aify-env-dashboard-grant-escape-2026-10-03):
// - `refs/heads` as a junction to another repository's: git reports that repository's HEAD, even with none of its
//   objects present;
// - `objects` as a junction to another repository's store;
// - `objects/info/alternates` naming another store, which a range log then reads commits from.
//
// TWO CHECKS, for two kinds of read.
//
// `quietContainmentOf` runs on EVERY look, before the fingerprint reads anything: it covers exactly what the
// fingerprint touches, `HEAD`, the ref `HEAD` names (each directory on the way to it), and `packed-refs`. None may be
// a link, `HEAD` and the ref must name a file with no second name, and the ref must be a plain name under `refs/`.
// A few lstat calls, so a quiet tick reads nothing through a link and costs no walk.
//
// `containmentOf` runs when something moved, before a head is reported or a range read: of the git directory and the
// shared one,
// - NO LINK at the top level of either, or anywhere under `refs/` or `objects/` (a loose object, a pack, an index, a
//   fan-out directory). git makes none of these, and Node's lstat reports a junction as a symbolic link (measured).
// - NO SECOND NAME for a loose ref (HEAD and packed-refs are judged every look). git rewrites each by renaming,
//   so a link count above one (measured on NTFS) means the file is someone else's, read live.
// - ALTERNATES ONLY INSIDE THE GRANT, by real path, followed to git's own depth.
// Walking `objects/` costs about 60 microseconds an entry (measured: about 500 entries in 30 ms), and git's own
// housekeeping keeps loose objects to a few thousand.
//
// NOT JUDGED: object and pack files with a second name. `git clone --local` makes those legitimately, and they are
// read only by an id the judged refs do not give away. NOT CLOSED: the moment between a check and git's read of the
// same files in the same look.
//
// FAILS CLOSED: anything that cannot be read refuses the folder.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { withinWatchRoots } from "../../watch-roots.mjs";

/** How many alternates deep git follows from one object store: its own limit. */
export const ALTERNATES_DEPTH = 5;

const absent = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const linkAt = (path) => `its git directory holds a link at ${path}`;
const secondName = (path) => `its git directory holds ${path}, a file with a second name somewhere else`;

/** One entry's lstat, or null when there is none. Anything else that goes wrong is thrown, to be refused. */
function entry(lstat, path) {
  try {
    return lstat(path);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

/**
 * Why what the fingerprint is about to read could lead out of the grant, or "". Every look, before it reads.
 *
 * @param {{gitDir: string, commonDir: string}} dirs  from `GitReader.gitDirs`
 * @param {object} [fs]  `lstat` and `readFile`; injected so a test can make one fail
 */
export function quietContainmentOf({ gitDir, commonDir }, fs = {}) {
  const { lstat = lstatSync, readFile = readFileSync } = fs;
  const single = (path) => {
    const found = entry(lstat, path);
    if (found === null) return "";
    if (found.isSymbolicLink()) return linkAt(path);
    return found.nlink > 1 ? secondName(path) : "";
  };
  try {
    const head = join(gitDir, "HEAD");
    const headWhy = single(head);
    if (headWhy) return headWhy;
    const packedWhy = single(join(commonDir, "packed-refs"));
    if (packedWhy) return packedWhy;
    if (entry(lstat, head) === null) return "";
    const text = String(readFile(head, "utf8")).trim();
    if (!text.startsWith("ref: ")) return "";
    const ref = text.slice("ref: ".length).trim();
    const parts = ref.split("/");
    if (parts[0] !== "refs" || parts.some((part) => part === "" || part === "." || part === "..")) {
      return `its HEAD names ${JSON.stringify(ref)}, which is not a ref under refs/`;
    }
    for (let depth = 1; depth < parts.length; depth += 1) {
      const dir = join(commonDir, ...parts.slice(0, depth));
      const found = entry(lstat, dir);
      if (found === null) return "";
      if (found.isSymbolicLink()) return linkAt(dir);
    }
    return single(join(commonDir, ...parts));
  } catch (error) {
    return `its git directory could not be read whole (${error?.message || error})`;
  }
}

/**
 * Why one folder's git directories hold a way out of the grant, in the words a doctor row shows, or "" when they do not.
 *
 * @param {{gitDir: string, commonDir: string}} dirs  from `GitReader.gitDirs`
 * @param {string[]} roots  the real paths of the granted roots
 * @param {string} platform
 * @param {object} [fs]  `lstat`, `readdir`, `readFile` and `realpath`; injected so a test can make one fail
 */
export function containmentOf({ gitDir, commonDir }, roots, platform, fs = {}) {
  const { lstat = lstatSync, readdir = readdirSync, readFile = readFileSync, realpath = realpathSync.native } = fs;
  const names = (dir) => {
    try {
      return readdir(dir);
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
  };
  // Links are never followed, so a walk ends: a directory is entered only through a real directory entry.
  const walk = (root, { secondNames }) => {
    const pending = [root];
    while (pending.length > 0) {
      const at = pending.pop();
      for (const name of names(at)) {
        const path = join(at, name);
        const found = lstat(path);
        if (found.isSymbolicLink()) return linkAt(path);
        if (found.isDirectory()) pending.push(path);
        else if (secondNames && found.nlink > 1) return secondName(path);
      }
    }
    return "";
  };

  try {
    const dirs = [...new Set([gitDir, commonDir])];
    for (const dir of dirs) {
      // A link at the top is caught here and never walked into: a walk reads a directory's entries, not the directory.
      for (const name of names(dir)) if (lstat(join(dir, name)).isSymbolicLink()) return linkAt(join(dir, name));
      // HEAD, packed-refs and the ref HEAD names were judged before the fingerprint read them (quietContainmentOf).
      // Every other ref still counts: `git log` reads refs/replace, so a tag is not the only thing one could stand for.
      const refs = walk(join(dir, "refs"), { secondNames: true });
      if (refs) return refs;
      const objects = walk(join(dir, "objects"), { secondNames: false });
      if (objects) return objects;
    }
    return alternatesOutside(dirs.map((dir) => join(dir, "objects")), roots, platform, { readFile, realpath });
  } catch (error) {
    return `its git directory could not be read whole (${error?.message || error})`;
  }
}

/**
 * The first object store an alternates file leads to outside the grant, as a doctor row's words, or "".
 *
 * Bounded by depth, not by remembering what was seen: two stores that name each other are followed only as deep as
 * git itself would follow them.
 */
function alternatesOutside(stores, roots, platform, { readFile, realpath }) {
  let level = stores;
  for (let depth = 0; depth <= ALTERNATES_DEPTH && level.length > 0; depth += 1) {
    const next = [];
    for (const store of level) {
      let text;
      try {
        text = String(readFile(join(store, "info", "alternates"), "utf8"));
      } catch (error) {
        if (absent(error)) continue;
        throw error;
      }
      for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry !== "" && !entry.startsWith("#"))) {
        // git reads a relative entry from the object store that names it.
        const named = isAbsolute(line) ? line : resolve(store, line);
        let real;
        try {
          real = realpath(named);
        } catch {
          return `its object store borrows objects from ${named}, which does not resolve to a real path`;
        }
        if (!withinWatchRoots(real, roots, platform)) return `its object store borrows objects from ${real}, outside every granted root`;
        next.push(real);
      }
    }
    level = next;
  }
  return "";
}
