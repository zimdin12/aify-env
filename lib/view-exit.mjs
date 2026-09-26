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
