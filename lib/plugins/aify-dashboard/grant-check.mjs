// A granted folder is read only when everything git reads for it is inside the grant as well.
//
// THE LISTED PATH IS NOT WHAT GIT READS. The external review of 0.8.1 (MEDIUM) showed three ways a folder inside the
// grant makes git read a repository outside it, and all three reproduced (aify-dashboard
// docs/evidence/aify-env-dashboard-grant-escape-2026-10-03):
// - a junction or symlink inside the grant that points outside it;
// - a `.git` FILE naming a git directory outside it;
// - a granted subfolder of a repository whose top level is outside it, which git walks up to.
// So the places git resolves are judged, by their REAL paths, against the real paths of the granted roots: the
// working tree's top level, the folder's own git directory, and the shared one its branch refs live in. A linked
// worktree whose main repository is outside the grant is refused for the same reason: its refs and history are that
// repository's, and the operator grants its folder too, or does not list the worktree.
//
// JUDGED ON EVERY LOOK, against the real paths of the roots the last refresh was granted. The places themselves are
// resolved again whenever the folder's binding moves, and the binding holds the real paths a `.git` file and
// `commondir` lead to (fingerprint.mjs), so a junction re-pointed on the way is a new binding. But a grant can be
// narrowed with the folder unchanged, and a folder whose git directories were resolved under the wider grant must
// be judged by the narrower one from the next refresh, not from the next time it happens to move.
//
// FAILS CLOSED. A place that cannot be resolved to a real path is refused, never taken as inside.

import { realpathSync } from "node:fs";

import { watchRootsFrom, withinWatchRoots } from "../../watch-roots.mjs";

/**
 * The real paths of the granted roots, spelled the way the roots are. A root that cannot be resolved (it does not
 * exist) is kept as written: nothing beneath it can be read either.
 */
export function realRoots(roots, { realpath = realpathSync.native, platform = process.platform } = {}) {
  const spelled = (path) => watchRootsFrom(JSON.stringify({ watchRoots: [path] }), platform).roots[0] ?? null;
  return roots.map((root) => {
    try {
      return spelled(realpath(root)) ?? root;
    } catch {
      return root;
    }
  });
}

/** The real paths of the places git reads for one folder, from `GitReader.gitDirs`; null for one that would not resolve. */
export function realPlaces({ toplevel, gitDir, commonDir }, { realpath = realpathSync.native } = {}) {
  const real = (path) => {
    try {
      return realpath(path);
    } catch {
      return null;
    }
  };
  return [["working tree", real(toplevel)], ["git directory", real(gitDir)], ["shared git directory", real(commonDir)]];
}

/** Why a folder may not be read, in the words a doctor row shows, or "" when every place is inside the grant. PURE. */
export function escapeOf(places, roots, platform = process.platform) {
  for (const [what, path] of places) {
    if (path === null) return `its ${what} could not be resolved to a real path`;
    if (!withinWatchRoots(path, roots, platform)) {
      return `its ${what} is ${path}, outside every granted root`;
    }
  }
  return "";
}
