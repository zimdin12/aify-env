// How to actually start a launcher, which is not the same as its path.
//
// The launchers are bash scripts with a shebang. On unix the kernel reads that and the path alone is
// enough. On Windows nothing reads it: spawning the script directly fails, and the failure arrives as
// "the agent did not start" with no reason attached to it.
//
// So the interpreter is DERIVED FROM THE FILE. The shebang is the file saying how it wants to be run,
// and the file is already being read for the allowlist, so this costs nothing extra and cannot
// disagree with the bytes that were judged. Deriving it from the extension instead is how a launcher
// gets run by the wrong shell — a `.sh` that asks for `sh` and one that asks for `bash` are not
// interchangeable, and the difference shows up as a syntax error in somebody else's file.

import { accessSync, constants } from "node:fs";

const SHEBANG = /^#![ \t]*(\S+)([^\n]*)/;

/**
 * Turn a command into something the operating system can open.
 *
 * `child_process` searches PATH for you. **node-pty does not**: handed `bash` it throws
 * `File not found:` with nothing else in it, and on the daemon that surfaced as a 500 with no clue
 * attached. So an interpreter plan has to end in a real path rather than in something a shell would
 * have found.
 *
 * Returns the input UNCHANGED when it cannot be resolved, rather than null. The caller may still be
 * using child_process, which does its own lookup, and returning nothing would break the path that
 * already worked in order to fix the one that did not.
 */
// POSIX shells that will be handed a WINDOWS path to run. Windows ships its own `bash.exe` in
// System32 -- the WSL launcher -- and that one cannot open C:\dir\launcher: it eats the backslashes
// during quote removal and reports "No such file or directory", exit 127. A host may legitimately have
// both, so the right move is to skip it and keep walking PATH, not to fail.
//
// Found on a live host. The suite could not see it because tests start their daemon from a Git-Bash
// parent, inheriting a PATH where Git bash comes first -- the same code taking the other branch.
const POSIX_SHELLS = new Set(["bash", "sh", "dash", "zsh"]);

function isWindowsSystem32(candidate) {
  const lower = String(candidate).toLowerCase().split(String.fromCharCode(92)).join("/");
  return lower.includes("/windows/system32/");
}

export function resolveExecutable(command, env = {}) {
  const name = String(command ?? "");
  if (name === "" || name.includes("/") || name.includes(String.fromCharCode(92))) return name;

  const win = (env.sep ?? (process.platform === "win32" ? ";" : ":")) === ";";
  const sep = env.sep ?? (win ? ";" : ":");
  const joiner = win ? String.fromCharCode(92) : "/";
  const pathValue = env.pathValue ?? process.env.PATH ?? "";
  const pathExt = env.pathExt ?? (win
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""]);
  const exists = env.exists ?? ((candidate) => {
    try {
      accessSync(candidate, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  });

  for (const dir of String(pathValue).split(sep).map((d) => d.trim()).filter(Boolean)) {
    const base = dir.endsWith(joiner) ? dir.slice(0, -1) : dir;
    for (const ext of pathExt) {
      const candidate = `${base}${joiner}${name}${ext}`;
      try {
        if (!exists(candidate)) continue;
        // LOOKED AT, then rejected -- the existence check runs first on purpose. A shell skipped
        // without being examined is indistinguishable from one that was never on PATH, and the
        // difference is the whole finding: WSL's bash IS there, and IS wrong for this job.
        if (win && POSIX_SHELLS.has(name.toLowerCase()) && isWindowsSystem32(candidate)) continue;
        return candidate;
      } catch {
        // One unreadable directory must not make every later directory unsearchable.
      }
    }
  }
  return name;
}

/**
 * @param {string} fileText   the launcher's contents, already read for the allowlist
 * @param {string} launcherPath
 * @param {string} platform   process.platform
 * @param {string[]} extraArgs  arguments for the launcher itself
 * @returns {{command: string, args: string[]}}
 */
export function interpreterFor(fileText, launcherPath, platform, extraArgs = []) {
  const direct = { command: launcherPath, args: [...extraArgs] };

  // Only Windows needs the help. Everywhere else the kernel already does this, and second-guessing it
  // would break launchers that work today.
  if (platform !== "win32") return direct;

  const match = SHEBANG.exec(String(fileText ?? ""));
  if (!match) return direct;

  const interpreterPath = match[1];
  const shebangArgs = match[2].trim().split(/\s+/).filter(Boolean);

  // `#!/usr/bin/env bash` means bash; env is the lookup, not the program.
  const parts = interpreterPath.split("/").filter(Boolean);
  let program = parts[parts.length - 1];
  let args = shebangArgs;
  if (program === "env" && shebangArgs.length > 0) {
    program = shebangArgs[0];
    args = shebangArgs.slice(1);
  }

  if (!program) return direct;

  // The script path goes AFTER the interpreter's own arguments and BEFORE the launcher's. Order is the
  // whole meaning: `bash --managed script` is a different command from `bash script --managed`, and
  // one of them is not the agent anybody asked for.
  // Resolved, because the plan may be handed to node-pty, which does no PATH lookup of its own.
  return { command: resolveExecutable(program), args: [...args, launcherPath, ...extraArgs] };
}
