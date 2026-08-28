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
//: How long the stops get before the exit happens anyway.
//:
//: `runner.stop()` can hang forever and this file already said so: "Promise.allSettled guards
//: against a rejection, not against a call that never returns -- so a hang here is a hang
//: forever." It was named and not bounded, and the operator hit it twice: `stopping 3 managed
//: process(es)`, three `stopping pN` lines, and then nothing, until they killed the terminal.
//:
//: FIVE SECONDS IS NOT A GUESS ABOUT node-pty. It is how long an operator will believe a clean
//: shutdown is still happening. Past that the choice is not "wait or exit" -- it is "exit, or be
//: killed and leave the same processes behind with no record".
const STOP_DEADLINE_MS = 5000;


export function createShutdown({
  runner, closeServer, clearOwned, exit, write = () => {}, beforeStop = () => {},
  stopDeadlineMs = STOP_DEADLINE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let shuttingDown = false;
  return async function shutdown(signal) {
    // A second Ctrl-C must not start a second teardown half way through the first -- but it must not
    // be ignored either. THE OPERATOR'S ACTUAL ESCAPE was to kill the terminal, which is the worst
    // available outcome: the managed processes survive AND the owned record goes with the window, so
    // nothing can ever reap them. Pressing Ctrl+C again is the reflex; making it exit turns that
    // reflex into the good outcome, because the record is kept and the next instance reaps them.
    //
    // This cannot rescue a shutdown wedged SYNCHRONOUSLY -- a signal handler needs the event loop as
    // much as the deadline timer does. It rescues the case that has actually been observed twice: a
    // stop whose promise never settles, where the loop is running the whole time.
    //
    // UNCONDITIONAL, and a gate on "have the stops been issued yet" was tried and removed as
    // decoration. Everything from `beforeStop()` to the last `runner.stop()` call runs synchronously
    // in one turn of the loop, so a second signal cannot be delivered before the stops are issued --
    // the window the gate protected does not exist. Its test failed on the first run, which is how it
    // was found; a gate whose condition is always true is a line nobody can ever see fail.
    if (shuttingDown) {
      write(`[aify-env] ${signal} again: exiting now, and KEEPING the owned record so the next `
        + `instance can reap whatever is still running
`);
      exit(0);
      return;
    }
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
    //
    // EACH ONE NAMED BEFORE IT IS STOPPED, never after. `stop()` can block the event loop
    // SYNCHRONOUSLY -- node-pty's ConPTY kill forks a console-list helper whose AttachConsole is
    // unbounded, which is why the dead-pid guard in `runner.stop` exists at all. On a run where that
    // happens, a line written after the call never reaches the screen and nothing else gets to run,
    // so the operator sees `stopping 3 managed process(es)` and nothing more, for hours.
    //
    // Observed AGAIN on 2026-08-27 with all three pids ALIVE at the signal, so the dead-pid guard did
    // not apply and the earlier fix could not have helped. This does not stop that hang -- it makes it
    // NAME ITSELF. The last line on screen becomes the process that wedged, which is the difference
    // between a report anybody can act on and "it froze at close again".
    // WHICH ONES CAME BACK. `allSettled` alone cannot say: it resolves once, at the end, and if one
    // stop never returns there is no end. Tracking each settle individually is what lets the timeout
    // below NAME the process that wedged instead of reporting that something did.
    const outstanding = new Set(owned.map((process_) => process_.id));
    const stops = owned.map((process_) => {
      write(`[aify-env] ${signal}: stopping ${process_.id} (pid ${process_.pid ?? "?"})
`);
      // CALLED SYNCHRONOUSLY, inside this callback, and that is the whole point of not writing it as
      // `Promise.resolve().then(() => runner.stop(...))`. Deferring the call to a microtask makes
      // every line print before any stop begins, which destroys the diagnostic the comment above
      // depends on: with the calls deferred, a SYNCHRONOUS wedge on the first process still shows all
      // N lines, so the screen no longer says which one it was.
      //
      // The existing ordering test could not see that -- it compares each `stopping X` line against
      // X's OWN completion, which batching satisfies too. `stops-are-entered-one-at-a-time` asserts
      // the interleaving instead.
      let settled;
      try {
        settled = Promise.resolve(runner.stop(process_.id));
      } catch (thrown) {
        // A stop that throws SYNCHRONOUSLY is a stop that finished, not one that wedged. Without
        // this the throw escapes the map and takes the whole teardown with it, leaving the remaining
        // processes unstopped -- the opposite of what allSettled is here for.
        settled = Promise.resolve();
      }
      return settled
        .catch(() => {})
        .finally(() => outstanding.delete(process_.id));
    });

    // THE EXIT IS NOT CONDITIONAL ON THE STOPS. Whichever finishes first wins: the stops, or the
    // deadline. A shutdown that can only complete when every child cooperates is not a shutdown.
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimer(resolve, stopDeadlineMs);
    });
    await Promise.race([Promise.allSettled(stops), deadline]);
    clearTimer(timer);

    const stuck = [...outstanding];
    if (stuck.length) {
      // SAY WHICH, and say what it means for the processes. "It froze at close" was all the operator
      // could report last time, because the screen said nothing after the third line.
      write(`[aify-env] ${signal}: ${stuck.join(", ")} did not confirm within ${stopDeadlineMs}ms; `
        + `exiting anyway and KEEPING the owned record so the next instance can reap them\n`);
    }

    // Cleared only after the stops have been attempted, and NOT AT ALL when some did not confirm.
    // The record is the only way a later instance can find a process this one failed to stop, so
    // erasing it on the timeout path would turn a slow shutdown into a permanent orphan.
    if (!stuck.length) {
      try {
        clearOwned();
      } catch {
        // Best effort: an unwritable record must not stop the exit.
      }
    }

    exit(0);
  };
}
