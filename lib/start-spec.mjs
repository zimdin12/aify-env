// Turning "run this launcher" into something the Runner can start, and the four ways it can refuse.
//
// WHY THIS IS ITS OWN MODULE. Two callers now need it: the HTTP endpoint, where a service asks over
// the wire, and a service PLUGIN running inside this process. Building the spec twice would give two
// answers that agree only until one is fixed -- and the half that would rot is the one nobody runs
// by hand. This project has already paid for that shape twice, with wrapper templates and with a
// doctor check reimplemented in two tiers.
//
// EVERY REFUSAL CARRIES ITS REASON, because the alternative is what these replaced: "the agent did
// not start", arriving minutes later from the component that could no longer say why. A launcher
// that cannot be read, one the allowlist refuses, and one with no interpreter on this host each send
// an operator somewhere completely different.
//
// PURE, with its filesystem and platform injected, so all four refusals can be exercised without a
// real launcher on a real host -- which is exactly the set that never gets tested otherwise.

import { mayExecute } from "./allowlist.mjs";
import { interpreterFor } from "./interpreter.mjs";

/** A spec the Runner accepts, or a refusal naming what to do about it. */
export function buildStartSpec({
  service = "",
  launcher = "",
  args = [],
  cwd,
  env,
  label = "",
} = {}, { readFile, platform = process.platform } = {}) {
  if (!service || typeof service !== "string") {
    return { error: { status: 400, detail: "a start request must name the service it is for" } };
  }
  if (!launcher || typeof launcher !== "string") {
    return { error: { status: 400, detail: "a start request must name a launcher to run" } };
  }

  let fileText;
  try {
    fileText = readFile(launcher);
  } catch (readError) {
    // FAILS CLOSED. "I could not open it" must never become "go ahead".
    return { error: { status: 403, detail: `cannot read ${launcher}: ${readError.code ?? readError.message}` } };
  }

  const verdict = mayExecute(fileText);
  if (!verdict.ok) {
    return { error: { status: 403, detail: `refused ${launcher}: ${verdict.reason}` } };
  }

  // How to run it comes from the file just judged, not from its name. On Windows nothing reads a
  // shebang, so a bash launcher spawned by path simply does not start -- and that failure arrived as
  // "the agent did not start" with no reason attached.
  const plan = interpreterFor(fileText, launcher, platform, Array.isArray(args) ? args : []);

  // A COMMAND THAT IS NOT A PATH CANNOT BE SPAWNED ON WINDOWS. node-pty says so by throwing
  // `File not found:`, which arrived as a 500 with nothing naming the cause. An operator starting
  // from a plain cmd prompt hit exactly this: no Git on PATH, both remaining bashes are WSL doorways
  // and correctly skipped, and the resolver fell back to the bare name.
  //
  // A plain check rather than a character class: `[/` + backslash + `]` builds a class the backslash
  // escapes open, and that threw inside the request handler and became the very 500 this replaces.
  const looksLikeAPath = (value) => value.includes("/") || value.includes(String.fromCharCode(92));
  if (platform === "win32" && plan.command && !looksLikeAPath(plan.command)) {
    return {
      error: {
        status: 422,
        detail: `cannot run ${launcher}: no POSIX shell was found to interpret it. "${plan.command}" is `
          + 'not a path, so it cannot be spawned. Install Git for Windows, or put a bash that can open '
          + "C: paths on PATH -- a WSL bash is deliberately skipped because it cannot open them.",
      },
    };
  }

  return {
    spec: {
      service,
      fileText,
      command: plan.command,
      args: plan.args,
      // WHAT WAS ASKED FOR, kept beside how it will be run. The record the reaper verifies against
      // has to name THIS process, and `plan.command` is `bash.exe` for any shebang launcher on
      // Windows -- a name shared with every other bash-launched process on the host. The launcher
      // path is the discriminating half, and `interpreterFor` puts it in `args`, so verifying
      // against it matches exactly the process that was started.
      launcher,
      // The caller's own name for this work. This tier stores and displays it and reads no meaning
      // into it: knowing what an agent IS is not its job.
      label: typeof label === "string" ? label : "",
      cwd: typeof cwd === "string" ? cwd : undefined,
      env: env && typeof env === "object" && !Array.isArray(env) ? env : undefined,
    },
  };
}
