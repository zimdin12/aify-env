// Which port this daemon was asked to listen on, or why the answer is not usable.
//
// EXTRACTED FROM `bin/aify-env.mjs` on 2026-09-04, because adding the validation below took that
// file to 1001 lines and this repo's gate stops at 1000. The rule for relieving one is to move a
// SUBJECT rather than whichever block is longest, and "read one argument and judge it" is a whole
// subject: pure, decidable, and with no business in an entry point that also owns a server, a
// process record and a view.
//
// AND IT COULD NOT BE TESTED WHERE IT WAS. `bin/aify-env.mjs` STARTS A DAEMON when imported -- this
// project has killed a live fleet finding that out -- so every case below could only ever be checked
// by launching a process and reading its stderr. Here they are ordinary function calls.
//
// WHAT IT FIXES: `--port` with nothing after it reached `listen()` as NaN and died with an uncaught
// ERR_SOCKET_BAD_PORT. A stack trace for a typo, from a daemon whose whole job is to be running.
// External review, Round 8.

/** The default when no `--port` is given. Kept beside the parser that applies it. */
export const DEFAULT_PORT = 8802;

/**
 * @param {string[]} argv          the daemon's arguments, without node and the script
 * @param {number} [fallback]      the port to use when `--port` is absent
 * @returns {{port: number} | {error: string}}
 */
export function portFromArgs(argv = [], fallback = DEFAULT_PORT) {
  const args = (Array.isArray(argv) ? argv : []).map(String);
  const at = args.indexOf("--port");
  if (at === -1) return { port: fallback };

  const raw = String(args[at + 1] ?? "").trim();
  if (!raw) return { error: "--port needs a number from 0 to 65535 and was given none." };

  const parsed = Number(raw);
  // `--port 0` IS LEGAL and is what every test in this suite uses: it asks the OS for a free one. So
  // the guard is on the SHAPE of the value and never on truthiness -- `!parsed` would refuse exactly
  // the case the suite depends on, and the failure would look like the suite being broken.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return { error: `--port needs a number from 0 to 65535 (got "${raw}").` };
  }
  return { port: parsed };
}
