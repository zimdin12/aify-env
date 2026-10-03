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
// - NO SECOND NAME for an object or pack file either, in the folder's store or in any store it borrows from. An id is
//   not the content: git does not re-hash a loose object it reads, so when the other name's owner rewrote the shared
//   file, `git log` read their subject under the old id (review of bf4ce1c, G-HARDLINK). `git clone` of a local path
//   makes exactly these, so the row names the fix: re-clone with --no-hardlinks. A clone from a URL, a linked
//   worktree and `git gc` make none.
// - ALTERNATES ONLY INSIDE THE GRANT, by real path, followed to git's own depth.
// Walking `objects/` costs about 60 microseconds an entry (measured: about 500 entries in 30 ms), and git's own
// housekeeping keeps loose objects to a few thousand.
//
// NOT CLOSED: a write inside these directories in the moment between a check and git's read of the same files in the
// same look (head-watcher.mjs).
//
// FAILS CLOSED: anything that cannot be read refuses the folder.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { withinWatchRoots } from "../../watch-roots.mjs";

/** How many alternates deep git follows from one object store: its own limit. */
export const ALTERNATES_DEPTH = 5;

const absent = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const linkAt = (path) => `its git directory holds a link at ${path}`;
const secondName = (path) => `its git directory holds ${path}, a file with a second name somewhere else`;
const secondObject = (path) => `its git directory holds ${path}, an object file with a second name somewhere else, as a clone of a local path makes; re-clone it with --no-hardlinks`;

/** Whether two absolute paths name the same place spelled the same way, as this host's file system compares them. */
function samePath(a, b) {
  const plain = (path) => normalize(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? plain(a).toLowerCase() === plain(b).toLowerCase() : plain(a) === plain(b);
}

/**
 * Why a linked worktree's `commondir` could lead git somewhere other than the shared directory judged, or "".
 *
 * ⛔ GIT FOLLOWS THE TEXT, at every read, and GIT_DIR does not change that (review of b92c9bd): a commondir naming the
 * shared directory through a junction, re-pointed after the checks, had the outside head read on that look. So the
 * named path must be, as spelled, the shared directory that was judged. That one is a real path (grant-check.mjs), so
 * a named path with a link anywhere on the way is never it.
 */
function commondirWhy(gitDir, commonDir, { readFile }) {
  let text;
  try {
    text = String(readFile(join(gitDir, "commondir"), "utf8")).trim();
  } catch (error) {
    if (absent(error)) return "";
    throw error;
  }
  const named = resolve(gitDir, text);
  if (samePath(named, commonDir)) return "";
  return `its commondir names ${named}, which is not the shared git directory itself (${commonDir}) but a way to it git would follow again later`;
}

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
 * Whether git would take `ref` as the name of a ref under `refs/`: the parts of its check_refname_format a path can
 * feel. PURE.
 *
 * ⛔ `..` IS REFUSED ANYWHERE IN THE NAME, not only as a part between slashes. Windows reads a backslash as a
 * separator, so `refs/heads/x\..\..\..\elsewhere` passed a check that split on `/` and still named a file outside the
 * git directory (measured). The backslash is refused too, as git refuses it; either rule alone stops that name.
 */
export function isRefName(ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/") || ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("@{")) return false;
  // Control characters, space, and the characters git keeps for revision syntax, the backslash among them.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  // An empty part is also how a trailing "/" and a "//" are refused.
  return ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/**
 * The first link or second-named file found under `root`, or null. Links are never followed, so the walk ends: a
 * directory is entered only through a real directory entry.
 */
function walk(root, { lstat, readdir }) {
  const pending = [root];
  while (pending.length > 0) {
    const at = pending.pop();
    let names;
    try {
      names = readdir(at);
    } catch (error) {
      if (absent(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = join(at, name);
      const found = lstat(path);
      if (found.isSymbolicLink()) return { link: path };
      if (found.isDirectory()) pending.push(path);
      else if (found.nlink > 1) return { second: path };
    }
  }
  return null;
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
    const commonWhy = commondirWhy(gitDir, commonDir, { readFile });
    if (commonWhy) return commonWhy;
    if (entry(lstat, head) === null) return "";
    const text = String(readFile(head, "utf8")).trim();
    if (!text.startsWith("ref: ")) return "";
    const ref = text.slice("ref: ".length).trim();
    if (!isRefName(ref)) return `its HEAD names ${JSON.stringify(ref)}, which is not a ref name git accepts under refs/`;
    const parts = ref.split("/");
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
  try {
    const dirs = [...new Set([gitDir, commonDir])];
    for (const dir of dirs) {
      // A link at the top is caught here and never walked into: a walk reads a directory's entries, not the directory.
      for (const name of readdir(dir)) if (lstat(join(dir, name)).isSymbolicLink()) return linkAt(join(dir, name));
      // HEAD, packed-refs and the ref HEAD names were judged before the fingerprint read them (quietContainmentOf).
      // Every other ref still counts: `git log` reads refs/replace, so a tag is not the only thing one could stand for.
      const refs = walk(join(dir, "refs"), { lstat, readdir });
      if (refs) return refs.link ? linkAt(refs.link) : secondName(refs.second);
      const objects = walk(join(dir, "objects"), { lstat, readdir });
      if (objects) return objects.link ? linkAt(objects.link) : secondObject(objects.second);
    }
    return alternatesOutside(dirs.map((dir) => join(dir, "objects")), roots, platform, { lstat, readdir, readFile, realpath });
  } catch (error) {
    return `its git directory could not be read whole (${error?.message || error})`;
  }
}

/**
 * The first object store an alternates file leads to that is outside the grant, or that holds a link, as a doctor
 * row's words, or "".
 *
 * ⛔ A BORROWED STORE IS WALKED, not only placed. One inside the grant whose `pack/` is a junction out of it lets
 * `git log` read the outside history while its own path passes (measured).
 *
 * Bounded by depth, not by remembering what was seen: two stores that name each other are followed only as deep as
 * git itself would follow them.
 */
function alternatesOutside(stores, roots, platform, { lstat, readdir, readFile, realpath }) {
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
        // git reads the line's text, not where it led when judged (review of b92c9bd, as for commondir).
        if (!samePath(named, real)) return `its object store borrows objects from ${named}, which is reached through a link (to ${real}) git would follow again later`;
        const held = walk(real, { lstat, readdir });
        if (held?.link) return `its object store borrows objects from ${real}, which holds a link at ${held.link}`;
        if (held) return `its object store borrows objects from ${real}, which holds ${held.second}, a file with a second name somewhere else`;
        next.push(real);
      }
    }
    level = next;
  }
  return "";
}
