// How the DAEMON shows itself, and what its keyboard is allowed to do.
//
// Extracted from `bin/aify-env.mjs` when giving that screen a keyboard took the file past the
// 1000-line gate. Taken out as a SUBJECT rather than as whichever block was longest: "what the
// running daemon puts on its own terminal, and what a keypress there means" is one responsibility,
// and it is the one that had no test because `bin/aify-env.mjs` cannot be imported -- importing it
// STARTS a daemon, which supersedes the operator's and reaps its workers. Every rule below was a
// comment in a file nothing could execute.
//
// ── THE KEYBOARD POLICY, which is the whole reason this is worth its own module.
//
// The daemon's view had NO keyboard until 2026-09-06. That was not an oversight: raw mode stops
// Ctrl+C becoming SIGINT -- it arrives as a byte -- and while `q` and Ctrl+C shared a single "quit"
// action there were exactly two possible wirings and both were wrong.
//
//   ignore the action  -> the operator can no longer stop the daemon from its own terminal
//   honour the action  -> a stray `q` reaps every managed agent on the host
//
// So `keys.mjs` reports them separately and this module maps them:
//
//   Ctrl+C  -> the daemon's OWN shutdown, the same one the signal handlers call. One teardown path,
//              because two that disagree is a defect this repo has already removed once.
//   q       -> nothing. There is no view to leave: this screen belongs to the running daemon, so
//              "quit" could only mean stopping it, and that is Ctrl+C's job. Held to one key that
//              nobody presses by accident, and the hint line does not offer it.
//
// A CLIENT IS THE OPPOSITE CASE and stays in `bin/aify-env-tui.mjs`: leaving costs nothing there, so
// both keys mean leave. `startDashboard` falls back to `onQuit` when no `onInterrupt` is given,
// which is exactly that behaviour and why the client needed no change.
//
// KEYSTROKES GO STRAIGHT TO THE RUNNER. This process owns the PTY, so posting to our own loopback
// port would add a round-trip, a failure mode, and a second place a keystroke could be refused.
//
// ── THE SCREEN MUST BE RELEASED SYNCHRONOUSLY ON THE WAY OUT, and this is where that is owed.
//
// Found by an independent review of this change, 2026-09-06, and confirmed by driving the real
// `createShutdown`. `shutdown.mjs` calls its `beforeStop` WITHOUT awaiting it -- deliberately, so a
// hanging plugin cannot delay a teardown -- while the daemon passes an ASYNC callback. So anything
// after the first `await` in there runs only if the process survives to run it, and on this path it
// does not: `exit` is `process.exit(0)`.
//
// That was cosmetic while the view only stopped a redraw timer. It stopped being cosmetic the moment
// this module put the terminal into RAW MODE, because `stop()` is now the only thing that takes it
// back out. Measured: with the plugin stop resolving in microtasks the restore landed; with one
// macrotask or one 20ms fetch it did not, ever. One Ctrl+C would have exited the daemon and left the
// operator's shell echoing nothing, with a `data` listener still attached -- and the double-Ctrl+C
// reflex `shutdown.mjs` explicitly designs for skips that callback's tail unconditionally.
//
// The fix is an ORDERING in `bin/aify-env.mjs`: release the screen before the first await. It costs
// the plugins nothing, because what has to precede `runner.stop()` is `stopAll()`, and
// `runner.stop()` runs after the whole callback returns either way.

import { startDashboard } from "./dashboard.mjs";

/**
 * Start the daemon's own view, or decline to.
 *
 * DECLINING IS A NORMAL OUTCOME, not a failure. Piped or redirected output -- a service manager, a
 * log file, a test capturing startup -- keeps the plain banner, because screen-clearing escapes in a
 * log are noise nobody asked for and that banner is what those readers parse.
 *
 * @param {object} deps every input injected, so this is reachable without starting a daemon
 * @returns {Promise<{stop: () => void, ownsScreen: boolean}>}
 */
export async function startDaemonView({
  endpoint,
  registryPath,
  runner,
  shutdown,
  notices = null,
  stdout = process.stdout,
  stdin = process.stdin,
  enabled = true,
  intervalMs = 2000,
  color = true,
  write = (line) => process.stderr.write(line),
  start = startDashboard,
} = {}) {
  // A view that cannot draw must never stop the environment from serving: it is the decoration, the
  // daemon is the product. `ownsScreen` false means the caller keeps writing its own lines.
  const declined = { stop: () => {}, ownsScreen: false };
  if (!enabled || !stdout?.isTTY) return declined;

  try {
    const view = await start({
      endpoint,
      registryPath,
      intervalMs,
      columns: stdout.columns || 100,
      color,
      notices,
      rows: stdout.rows || 24,
      // ONLY WITH A REAL KEYBOARD. `stdout.isTTY` says we own a screen; a process whose stdin is a
      // pipe has nothing to put into raw mode, and asking would throw on the first keypress.
      ...(stdin?.isTTY ? {
        input: stdin,
        onInterrupt: () => { void shutdown?.("keyboard"); },
        // NO `onQuit` -- see the header. Its absence is what keeps `q` inert and keeps the hint line
        // honest, because `dashboard.mjs` derives the hint from the callbacks it was actually given.
        onInput: (target, data) => {
          if (target?.id) runner?.write?.(target.id, data);
        },
      } : {}),
    });
    return { stop: view.stop, ownsScreen: true };
  } catch (failure) {
    write(`[aify-env] dashboard unavailable: ${failure.message}\n`);
    return declined;
  }
}
