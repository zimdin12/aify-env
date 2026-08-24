// Stopping this environment takes its processes with it.
//
// THE OPERATOR'S RULE, stated 2026-08-24: "if aify-env dies then all processes that it handles should
// die with it. no orphans etc." This module is that rule, in one place, so there is nothing for a
// second opinion to disagree with.
//
// It exists because there WERE two opinions. `bin/aify-env.mjs` registered two SIGINT/SIGTERM
// handlers: one that stopped every managed process ("AND DIE TOGETHER"), and one that closed the
// server and exited on the grounds that "this environment going down is not a reason to kill somebody
// else's agent". Node runs both, so the winner was whichever reached `process.exit(0)` first -- and
// that was the second one, because `server.close()` fires on the next tick when nothing is connected
// while killing a process tree does not. The daemon exited and its agents kept running until the next
// start reaped them from the record. That gap is the orphan window the rule forbids.
//
// EXIT IS NOT DRIVEN BY `server.close`. Its callback waits for open connections, and a console holding
// an SSE stream never closes on its own, so hanging the exit on it means either never exiting or
// exiting for the wrong reason. The server is told to stop ACCEPTING and then ignored; what gates the
// exit is the processes being stopped.
//
// The record on disk still covers the hard kill that runs no handler at all -- SIGKILL, and on Windows
// every external stop, since TerminateProcess runs nothing. Both halves are needed and neither
// replaces the other.

/**
 * Build the one shutdown path.
 *
 * The server arrives as a FUNCTION rather than the object. Destructuring a `{ server }` property
 * reads it eagerly, and the caller's server is declared further down its own module -- so taking the
 * object would throw on the temporal dead zone at construction time. This file's sibling has shipped
 * that exact class of bug once already, in `chr10`.
 *
 * Every dependency is injected so the ORDER can be asserted without sending a signal to a real
 * process -- which on Windows is impossible to do gracefully at all, and is why the integration test
 * for this behaviour skips there and left the conflict above unverified on the operator's own fleet.
 *
 * @param {{
 *   runner: {list: () => Array<{id: string}>, stop: (id: string) => Promise<unknown>},
 *   closeServer?: () => unknown,
 *   clearOwned: () => void,
 *   exit: (code: number) => void,
 *   write?: (line: string) => void,
 *   beforeStop?: () => void,
 * }} deps
 * @returns {(signal: string) => Promise<void>} idempotent; later signals are ignored
 */
export function createShutdown({
  runner, closeServer, clearOwned, exit, write = () => {}, beforeStop = () => {},
}) {
  let shuttingDown = false;
  return async function shutdown(signal) {
    // A second Ctrl-C must not start a second teardown half way through the first.
    if (shuttingDown) return;
    shuttingDown = true;

    // Anything that must stop BEFORE the teardown is visible -- today the live view, whose next frame
    // would paint a screen that is already untrue. It must never be able to prevent the teardown, so
    // a throw here is swallowed rather than propagated.
    try {
      beforeStop();
    } catch {
      // A decoration that fails to stop is not a reason to leave agents running.
    }

    const owned = runner.list();
    write(`[aify-env] ${signal}: stopping ${owned.length} managed process(es)\n`);

    // Stop ACCEPTING first so nothing new arrives mid-teardown. Deliberately not awaited: see above.
    try {
      closeServer?.();
    } catch {
      // A server that was never listening, or is already closed, is not a reason to leak processes.
    }

    // allSettled, not all: one process that refuses to die must not strand the rest.
    await Promise.allSettled(owned.map((process_) => runner.stop(process_.id)));

    // Cleared only after the stops have been attempted. Clearing first would erase the record of
    // exactly the processes a crash mid-teardown would leave behind.
    try {
      clearOwned();
    } catch {
      // Best effort: an unwritable record must not stop the exit.
    }

    exit(0);
  };
}
