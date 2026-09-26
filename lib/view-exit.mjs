// How `aify-env tui` ends, kept where a test can reach it: importing the entrypoint STARTS a view that
// talks to a daemon, so anything written there can only ever be read, never exercised.

/**
 * The signals that end a process which is only a view (v0.7.1 review, E2).
 *
 * SIGBREAK IS Ctrl+Break ON WINDOWS, and node's default for it is to terminate -- with the view still
 * on the alternate screen and the cursor hidden. SIGHUP is the terminal going away. The daemon already
 * listens for all four; the client listened for two.
 */
export const LEAVING_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);

//: How long quitting waits for keys still queued for an agent: the bound `aify-env attach` uses on
//: detach, long enough for a keystroke in flight to land, short enough that a dead daemon cannot hold
//: the terminal.
export const QUIT_DRAIN_MS = 500;

/**
 * Leave the view: the operator's screen first, then what was typed, then the process (v0.7.1 review,
 * E3). Exiting at once dropped keys still queued behind a send in flight -- often a line's Enter.
 *
 * THE SCREEN GOES FIRST so the wait is spent at a prompt, not on a frozen view; the exit comes
 * whether or not everything was sent, because the bound is the promise.
 */
export async function quitView({ stop, drainedWithin = async () => true, exit, drainMs = QUIT_DRAIN_MS }) {
  stop();
  await drainedWithin(drainMs);
  exit(0);
}
