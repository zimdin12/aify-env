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

const SHEBANG = /^#![ \t]*(\S+)([^\n]*)/;

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
  return { command: program, args: [...args, launcherPath, ...extraArgs] };
}
