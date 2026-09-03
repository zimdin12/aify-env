// A POSIX launcher needs its own coreutils, and on Windows nothing puts them there.
//
// MEASURED 2026-09-03, on the first spawn this host ever ran end to end. Everything worked — the
// spawn was claimed, the control was claimed, the launcher was resolved past the `.cmd` shim, bash
// was found and started — and the wrapper died four hundred lines in:
//
//   C:/Users/Administrator/.local/bin/claude-aify: line 498: mktemp: command not found
//   exited 127
//
// `mktemp` is one of the coreutils that ships INSIDE Git for Windows, at `<Git>/usr/bin`. That
// directory is deliberately not on the Windows PATH — Git puts only `<Git>/cmd` there, because
// putting a second `find.exe` and `sort.exe` ahead of Windows' own would break unrelated software.
// A Git Bash WINDOW gets them because the shell's startup adds them; a `bash.exe script` spawned
// directly does not.
//
// SO THIS IS THE HOST'S JOB, not the wrapper's and not the service's. aify-env chose to run this
// file through that interpreter; making the interpreter's own toolchain reachable is part of
// choosing it. Asking every wrapper to stop using coreutils would be asking each of them to work
// around one host's packaging.
//
// DERIVED FROM THE INTERPRETER PATH, never a list of install locations. The resolver already found
// which bash this host will run; its toolchain sits at a known offset from it, so a machine with Git
// somewhere unusual — or two Gits, or a portable one — gets the directories belonging to the bash
// actually being used rather than to whichever install a hardcoded list mentioned first.

/**
 * Directories that must be on PATH for a launcher run through this interpreter.
 *
 * @param {string} interpreterPath the resolved interpreter, e.g. C:\\Program Files\\Git\\bin\\bash.exe
 * @param {{platform?: string, exists?: (path: string) => boolean}} [deps]
 * @returns {string[]} directories, most specific first; empty when there is nothing to add
 */
export function toolchainDirsFor(interpreterPath, { platform = process.platform, exists = () => false } = {}) {
  // ONLY WINDOWS NEEDS THIS. Everywhere else `/usr/bin` is already on every PATH, and prepending
  // directories to a working environment is a way to break launchers that work today.
  if (platform !== "win32") return [];

  const path = String(interpreterPath ?? "").split(String.fromCharCode(92)).join("/");
  if (!path) return [];

  // `<root>/bin/bash.exe` and `<root>/usr/bin/bash.exe` are both real layouts, so the root is found
  // by walking UP from the file rather than by assuming a depth. Anything else is not a layout this
  // knows, and guessing at one would put arbitrary directories on a child's PATH.
  const lower = path.toLowerCase();
  let root = "";
  if (lower.includes("/usr/bin/")) root = path.slice(0, lower.lastIndexOf("/usr/bin/"));
  else if (lower.includes("/bin/")) root = path.slice(0, lower.lastIndexOf("/bin/"));
  if (!root) return [];

  // ORDER IS THE DECISION. `usr/bin` holds the coreutils a POSIX script actually calls; `bin` holds
  // the shell itself and a handful of git wrappers. Only directories that EXIST are returned: a PATH
  // entry pointing nowhere is a lookup cost paid on every command a script runs.
  return [`${root}/usr/bin`, `${root}/bin`, `${root}/usr/local/bin`].filter((dir) => exists(dir));
}

/**
 * A child environment with the interpreter's toolchain reachable.
 *
 * PREPENDED, and that is deliberate: a launcher asking for `sort` means the POSIX `sort`, not
 * Windows' unrelated `sort.exe`, and the same is true of `find`. Appending would leave a wrapper
 * calling Windows' `find` with POSIX arguments — which fails in a way that reads as a bug in the
 * wrapper rather than in the environment that started it.
 *
 * ALREADY-PRESENT DIRECTORIES ARE NOT DUPLICATED. An operator who runs aify-env from a Git Bash
 * window already has these, and a PATH that accumulates a copy per spawn is a slow leak nobody
 * attributes.
 */
export function withToolchainOnPath(env, interpreterPath, deps = {}) {
  const dirs = toolchainDirsFor(interpreterPath, deps);
  if (dirs.length === 0) return env;

  const current = String(env?.PATH ?? env?.Path ?? "");
  const existing = new Set(
    current.split(";").map((entry) => entry.trim().toLowerCase().replace(/[\\/]+$/, "")).filter(Boolean),
  );
  const missing = dirs.filter((dir) => !existing.has(dir.toLowerCase().replace(/[\\/]+$/, "")));
  if (missing.length === 0) return env;

  // WRITTEN AS `PATH`, and any differently-cased key the caller had is REMOVED rather than left
  // beside it. Windows treats environment names case-insensitively and Node does not: an env object
  // carrying both `Path` and `PATH` hands the child whichever the spawn layer happens to pick, and
  // the one it picked would be the copy without these directories.
  const next = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toLowerCase() !== "path") next[key] = value;
  }
  next.PATH = current ? `${missing.join(";")};${current}` : missing.join(";");
  return next;
}
