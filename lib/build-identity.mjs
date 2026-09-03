// WHICH CODE IS RUNNING, as opposed to which release it claims to be.
//
// THE INCIDENT, 2026-08-28. A shutdown hang was fixed, the operator restarted aify-env, and reported
// "still same old version". They were reading the banner, and the banner was right to say what it
// said: `aify-env ${version}`, where version is the `VERSION` file. That file had not changed,
// because a bug fix is not a release. Two builds three days apart printed the same line, so the one
// indicator on the screen could not answer the only question being asked -- am I running the fix?
//
// The daemon already reported the right SHAPE of thing: the banner reads `version` out of the running
// process's own `/health`, not off disk, so it genuinely describes the running process. Only the
// FIELD was wrong. This adds the field that moves.
//
// A CONTENT HASH, NOT A GIT SHA. Three reasons, in order of how much they matter here:
//
//   * It answers the question actually being asked. "Is the process running the code on my disk?" is
//     a question about bytes, and a commit sha cannot answer it while the working tree is dirty --
//     which is the state a fix is IN for the minutes before it is committed, and exactly when the
//     operator restarts to try it.
//   * It needs no build step. aify-comms stamps a sha with `scripts/stamp.sh` because its code ships
//     inside a container with no repo root. aify-env is run from a checkout by npm link, or from a
//     published package with no `.git` at all; a stamp would be a step to forget in one case and
//     impossible in the other.
//   * It cannot go stale. A stamp is written by a command somebody runs; this is computed from the
//     files being loaded, at the moment they are loaded.
//
// The cost is that the value does not name a commit. That is a real loss and it is paid for by the
// pairing: the banner shows what the RUNNING daemon loaded, `aify-env --version` shows what is on
// DISK now, and they are computed the same way. Equal means current. Different means restart. Neither
// number has to mean anything on its own for that comparison to be exact.

import { createHash } from "node:crypto";

/** How many hex characters of the digest to show. Long enough not to collide in practice, short
 *  enough to read off a screen and compare by eye, which is the only thing anyone does with it. */
export const BUILD_ID_LENGTH = 8;

/**
 * A short, stable identity for a set of source files.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION: the paths are sorted before hashing, so a directory listing that
 * comes back in a different order on a different filesystem still produces the same build. A hash
 * that changed with the readdir order would report a fresh build on every host and mean nothing.
 *
 * THE PATH IS HASHED WITH THE CONTENT. Renaming a module changes the build, which is correct -- the
 * loaded program is different -- and it stops two files swapping names from being invisible.
 *
 * @param {string[]} paths      absolute paths, in any order
 * @param {(path: string) => string} read
 * @param {(path: string) => string} [name] path -> the name to hash, so a caller can hash a stable
 *                                          relative name rather than an absolute one that differs per
 *                                          machine. Without it the same code installed in two places
 *                                          reports two builds.
 * @returns {string} lowercase hex, BUILD_ID_LENGTH characters
 */
export function buildIdentity(paths, read, name = (path) => path) {
  const digest = createHash("sha256");
  for (const path of [...paths].sort()) {
    // The NAME first, then a separator that cannot occur in either, then the bytes. Concatenating
    // without one lets a file called "ab" with content "c" hash the same as "a" with content "bc".
    digest.update(name(path));
    digest.update(String.fromCharCode(0));
    digest.update(read(path));
    digest.update(String.fromCharCode(0));
  }
  return digest.digest("hex").slice(0, BUILD_ID_LENGTH);
}

/**
 * The files that make up this program, DERIVED from what is on disk rather than listed.
 *
 * A list would be a second place to remember: a module added to `lib/` and forgotten here would be
 * loaded by the daemon and absent from its build, so changing it would report no change -- the exact
 * failure this whole module exists to end, reintroduced one directory down.
 *
 * IT WAS REINTRODUCED ONE DIRECTORY DOWN. Measured 2026-09-03: this listed `lib/*` NON-RECURSIVELY
 * and one file out of `bin/`, so the whole of `lib/plugins/` -- the aify-comms plugin, its API
 * client, its claim pass and its terminal-control pass, which is where a day of work lived -- was
 * invisible. Four commits changed the running program and the build id did not move once. The
 * operator restarts and compares that number to decide whether the restart took, so the one
 * instrument on the critical path was answering about a subset of the program.
 *
 * The docstring above predicted this exactly, which is the argument for walking rather than naming:
 * every rule about what to include is a rule somebody has to remember at the moment they add a
 * directory, and nobody does.
 *
 * @param {string} root        the package root
 * @param {(dir: string) => Array<{name: string, isDirectory: () => boolean}>} list  a directory
 *        reader returning DIRENTS -- `readdirSync(dir, {withFileTypes: true})`. Dirents rather than
 *        names because recursion needs to tell a directory from a file, and a caller that answers
 *        that with a second stat can disagree with the listing it came from.
 * @param {(...parts: string[]) => string} join
 * @returns {string[]} paths, unsorted
 */
export function sourceFiles(root, list, join) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = list(dir);
    } catch {
      // A directory this process cannot read contributes nothing rather than throwing. A build id
      // that cannot be computed would take the daemon down at boot, which is a far worse failure
      // than a build id computed over slightly less than everything.
      return;
    }
    for (const entry of entries || []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (!name || name === "node_modules") continue;
      const full = join(dir, name);
      const isDir = typeof entry === "object" && typeof entry.isDirectory === "function"
        ? entry.isDirectory()
        : false;
      if (isDir) walk(full);
      else if (name.endsWith(".mjs") || name.endsWith(".js")) found.push(full);
    }
  };
  // BOTH TREES. `bin/` holds the entry point -- its wiring, dependency bag and signal handlers are
  // the program as much as any module -- and also the doctor, the TUI and the credential command,
  // each of which is code an operator runs and would want to know the version of.
  walk(join(root, "lib"));
  walk(join(root, "bin"));
  return found;
}
