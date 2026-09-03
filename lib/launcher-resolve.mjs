// Which FILE on THIS machine a command name refers to.
//
// A HOST QUESTION, answered by the host. A service names the program it wants run — `claude-aify` —
// because it cannot know where this machine keeps it, or that this machine is Windows. Resolving
// that to a path is exactly the kind of thing the process host exists to do, and it is why this
// lives in `lib/` rather than in a service's plugin.
//
// THE WINDOWS TRAP, measured 2026-08-25 and the reason this is not one line. Resolving `claude-aify`
// the way you resolve an executable returns the generated `claude-aify.cmd` shim, which carries
// neither a shebang nor the wrapper marker — so a spawn was refused before it started, on every
// Windows host, while the command resolved perfectly well and the file existed:
//
//   what Windows would run  ->  ...\.local\bin\claude-aify.cmd   REFUSED by the allowlist
//   the sibling beside it   ->  ...\.local\bin\claude-aify       ACCEPTED
//
// The shim exists so the command works from cmd.exe and PowerShell; the file beside it IS the
// launcher, and that is the one this host runs through its own interpreter. On Linux the two are one
// path and all of this is inert — which is precisely why a seam "proven against a real environment"
// never saw it.
//
// IT RETURNS CANDIDATES AND JUDGES NONE OF THEM. The allowlist is the single authority on what may
// execute here, and a second marker test in this file would be a copy of it that agreed until one of
// them was corrected. The caller tries these in order through the spec builder and takes the first
// the allowlist accepts.

import { existsSync, statSync } from "node:fs";

/** Extensions Windows adds to make a script callable. None of them is the launcher. */
const SHIM_EXTENSIONS = [".cmd", ".bat", ".exe", ".ps1"];

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    // A path we cannot stat is a path we cannot run. Fails closed, like every other guard here.
    return false;
  }
}

/** `exists` may be injected, and an injected one that throws must not escape into the loop that
 *  starts every worker. Same rule as `isFile` above, applied to whatever the caller supplied. */
function safely(exists, path) {
  try {
    return Boolean(exists(path));
  } catch {
    return false;
  }
}

// THE SEPARATORS COME FROM THE `platform` ARGUMENT, NOT FROM `node:path`.
//
// This module imported `delimiter` and `join`, which answer for the machine RUNNING the code — so
// asking it about linux from Windows split `/usr/bin:/usr/local/bin` on `;` and produced one
// nonsense entry. Caught by its own tests, and it is worse than a test bug: a parameter that is
// accepted and then quietly ignored reads as supported. The two facts a path search needs are the
// list separator and the directory separator, and both follow from the platform being asked about.
const pathDelimiter = (platform) => (platform === "win32" ? ";" : ":");
const joinPath = (platform, dir, name) => {
  const separator = platform === "win32" ? String.fromCharCode(92) : "/";
  const base = String(dir).replace(/[\\/]+$/, "");
  return `${base}${separator}${name}`;
};

/**
 * Every path this command might be, best first.
 *
 * ORDERING IS THE WHOLE DECISION, which is why it is a pure function with its own tests rather than
 * a loop inside the caller: preferring the shim is what made spawning impossible on Windows, and
 * preferring the launcher is invisible on Linux.
 *
 * @param {string} command a bare name, or a path
 * @param {{env?: object, platform?: string, exists?: (path: string) => boolean}} [deps]
 * @returns {string[]} candidate paths, in the order they should be tried
 */
export function launcherCandidates(command, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  const value = String(command ?? "").trim();
  if (!value) return [];

  // A PATH IS TAKEN AS GIVEN. A caller that named a location meant that location, and searching PATH
  // for something that looks like a path would silently run a different file with the same basename.
  //
  // ASKED OF THE STRING, not of `node:path`. `isAbsolute` answers for the machine RUNNING this code,
  // so on Windows it called `/usr/bin/x` relative and went looking for it on PATH. A separator or a
  // drive letter is what makes a value a path, on either platform.
  if (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    return safely(exists, value) ? preferLauncherOverShim(value, { exists }) : [];
  }

  const windows = platform === "win32";
  const dirs = String(env.PATH || env.Path || "").split(pathDelimiter(platform)).filter(Boolean);
  // PATHEXT, and the EMPTY extension FIRST. The extensionless file is the launcher; the shim beside
  // it is what Windows would pick, and picking it is the defect this module is named after.
  const extensions = windows
    ? ["", ...String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];

  const found = [];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = joinPath(platform, dir, value + extension.toLowerCase());
      if (safely(exists, candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * For an already-resolved path, the launcher before its shim.
 *
 * Kept separate so a caller that resolved a command some other way — a doctor, a test, a future
 * host command — gets the same ordering without re-deriving it.
 */
export function preferLauncherOverShim(resolvedPath, { exists = isFile } = {}) {
  const path = String(resolvedPath ?? "");
  if (!path) return [];
  const lower = path.toLowerCase();
  const shim = SHIM_EXTENSIONS.find((extension) => lower.endsWith(extension));
  if (!shim) return [path];
  const bare = path.slice(0, -shim.length);
  // The extensionless sibling FIRST, and only if it is really there: a shim with no launcher beside
  // it is a legitimate state on a host where the wrapper was installed differently, and inventing
  // the sibling's path would make the caller report "cannot read" about a file nobody installed.
  return safely(exists, bare) ? [bare, path] : [path];
}
