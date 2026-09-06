// What `aify-env` accepts, and the refusal that keeps a typo from starting a daemon.
//
// THE DEFECT THIS EXISTS FOR: `aify-env --help` STARTED THE ENVIRONMENT.
//
// `bin/aify-env.mjs` dispatched subcommands under `if (firstArg && !firstArg.startsWith("-"))`, so
// every dash-prefixed argument skipped that block entirely and fell through to `listen()`. Starting
// an environment when one is already running SUPERSEDES it, and the incumbent's managed workers die
// with it -- they cannot be adopted, because a PTY-backed child is bound to a ConPTY its parent
// owns. So the single most natural thing a new user types would have reaped the operator's fleet.
//
// The file already guarded the neighbouring case and said why: an unknown SUBCOMMAND is refused
// because "a typo like `aify-env doctr` silently STARTS the environment ... the one mistake here
// that costs someone their fleet". The guard was correct and its condition excluded exactly the
// arguments a person types when they do not yet know the tool.
//
// FAIL CLOSED, THEREFORE: an argument this file does not recognise is refused, not ignored. A guard
// that passes when its input is unfamiliar is decoration.
//
// LIVES IN lib/ BECAUSE bin/ CANNOT BE IMPORTED. Importing `bin/aify-env.mjs` starts a daemon, so
// anything left in there is reachable by no test -- which is how this survived. Every rule here is
// callable.

/**
 * The flags the daemon itself understands.
 *
 * A LIST, WITH A TEST THAT KEEPS IT HONEST. Ideally this would be derived, but the truth is spread
 * across `args.includes()` calls and a separate parser module, and a list that can silently fall
 * behind is the shape this repo keeps getting caught by. So `tests/usage.test.js` scans
 * `bin/aify-env.mjs` for every argument it reads and fails if one is missing here -- adding a flag
 * without declaring it is a red test rather than a flag nobody can use.
 */
export const DAEMON_FLAGS = ["--version", "--force", "--port"];

/** Asking for help is not an error, and must never be a side effect. */
export const HELP_FLAGS = ["--help", "-h"];

/**
 * THE ONE COPY of what this command accepts.
 *
 * It used to live only in `bin/aify-env.mjs`'s header comment, where no reader outside the source
 * could reach it and nothing could print it. Two copies of a command list is the drift this repo has
 * documented three separate times; there is one, and `--help` prints it.
 */
export const USAGE = [
  "aify-env — the environment for this host: it owns processes and terminals so more than one",
  "service can start agents here without two spawners fighting over the same PTYs.",
  "",
  "  aify-env                    run in the foreground on 127.0.0.1:8802, showing the live view.",
  "                              When one is already running WITH AGENTS this shows it instead of",
  "                              replacing it — starting a second one ends the first one's work.",
  "  aify-env tui                the live view alone, against a daemon already running",
  "  aify-env attach <agent>     give one process this whole terminal; Ctrl+] detaches and it",
  "                              keeps running",
  "  aify-env doctor             what this host can say about itself, and what each service said",
  "  aify-env credential ...     store and reference the key a service needs",
  "  aify-env run --service <s> --launcher <path> [--label <id>] -- <args...>",
  "                              start a program HERE and attach to it, so it outlives this",
  "                              terminal. `claude-aify --shared` is one line calling this.",
  "",
  "  --force                     take the port even though the incumbent is running agents,",
  "                              ending them",
  "  --port <n>                  bind a different port; 0 asks the OS for a free one",
  "  --version                   print the release and the build actually loaded",
  "  --help, -h                  this text",
  "",
  "IN THE VIEW (aify-env and aify-env tui):",
  "  ↑ ↓ or j k                  move between agents",
  "  1-9                         jump straight to that row",
  "  g                           find: type to filter, Enter chooses, Ctrl+] cancels",
  "  Enter                       attach the keyboard to the selected agent",
  "  Ctrl+]                      let go — back to the list, the agent keeps running",
  "  q                           leave the view (aify-env tui only; in the daemon's own",
  "                              terminal Ctrl+C stops the environment instead)",
  "",
  "  ●  producing output just now      ○  gone quiet      (blank: nothing measured yet)",
  "  ❯  selected                       ▶  your keyboard is inside this agent",
].join("\n");

/**
 * The arguments that belong to `aify-env` itself, stopping at `--`.
 *
 * EVERYTHING AFTER `--` IS THE CHILD'S ARGV. `aify-env run --launcher <x> -- --help` is asking the
 * LAUNCHER for help, and reading it as our own printed this usage and exited 0 -- so
 * `<wrapper> --shared` would have started nothing and reported success. Caught by an existing test
 * that drives the real dispatcher with exactly that shape, which is the only reason it did not ship.
 *
 * `--version` had the same flaw before any of this and is now routed through here too: a launcher
 * asked for its version would have been answered with aify-env's.
 */
export function daemonArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const stop = list.indexOf("--");
  return stop === -1 ? list : list.slice(0, stop);
}

/**
 * The first argument this command does not understand, or null.
 *
 * SUBCOMMANDS ARE NOT THIS FUNCTION'S BUSINESS -- `bin/aify-env.mjs` already refuses an unknown one
 * and names the known ones. This answers only the dash-prefixed half, which had no guard at all.
 *
 * `--port` CONSUMES ITS VALUE, so a bare number after it is not an unknown flag. Without that, the
 * documented `--port 0` every test in this suite uses would be refused.
 *
 * @param {string[]} args argv past the script name
 * @param {string[]} [known] the accepted flags, injected so a test can drive this at any vocabulary
 */
export function unknownFlag(args, known = DAEMON_FLAGS) {
  const accepted = new Set([...known, ...HELP_FLAGS]);
  const list = daemonArgs(args);
  // A SUBCOMMAND OWNS ITS OWN FLAGS, and this answers null rather than relying on the caller to ask
  // at the right moment. `doctor --json`, `tui --once`, `run --service ... --launcher ...`: none of
  // those are the daemon's vocabulary, and refusing them would break every one.
  //
  // THE CALL SITE ALREADY ORDERS THIS CORRECTLY -- the refusal runs after the dispatch, which exits
  // for every subcommand -- and that is exactly why the guard belongs here too. I placed this check
  // BEFORE the dispatch on the first attempt and broke four subcommands; a rule that is only correct
  // because of where it is called is a rule waiting for the next person to move it.
  if (list.length > 0 && !String(list[0] ?? "").startsWith("-")) return null;
  for (let at = 0; at < list.length; at += 1) {
    const arg = String(list[at] ?? "");
    if (!arg.startsWith("-")) continue;
    if (!accepted.has(arg)) return arg;
    // A flag that takes a value swallows the next argument, so it is not examined as a flag itself.
    if (arg === "--port") at += 1;
  }
  return null;
}

/** True when the operator asked for help. Checked anywhere in argv, like `--version` already is. */
export function asksForHelp(args) {
  return daemonArgs(args).some((arg) => HELP_FLAGS.includes(String(arg ?? "")));
}

/** Whether the operator asked for OUR version, rather than a launcher's. */
export function asksForVersion(args) {
  return daemonArgs(args).includes("--version");
}

/**
 * Refuse an argument we do not understand, or say nothing and let the daemon start.
 *
 * THE WHOLE DECISION, not just the predicate. A predicate proven in isolation leaves its CALL SITE
 * unproven, and the call site is in `bin/aify-env.mjs`, which no test can import -- so a correct
 * `unknownFlag` wired to nothing would look exactly like this working. Both effects are injected.
 *
 * @returns {boolean} whether the caller should stop
 */
export function refuseUnknownFlag(args, { write, exit }) {
  const stray = unknownFlag(args);
  if (!stray) return false;
  const eol = String.fromCharCode(10);
  write(`aify-env: unknown option '${stray}'.${eol}`);
  write(`Run \`aify-env --help\` to see what this command accepts.${eol}`);
  exit(64);
  return true;
}
