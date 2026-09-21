// What this daemon does on its way out, in the order it has to happen.
//
// A SEPARATE FILE BECAUSE THE ORDER IS THE BEHAVIOUR. `lib/shutdown.mjs` owns the sequence every
// aify-env shutdown follows -- wait for `beforeStop`, stop accepting, stop the processes, clear the
// record, exit. What belongs to THIS daemon is which of its parts go in which of those slots, and
// that decision lived inside `bin/aify-env.mjs`, where nothing could reach it: importing that file
// RUNS a daemon, which supersedes the one serving the host. So the one thing a test most needed to
// see was the one thing it could not.
//
// EVERY PART ARRIVES AS A GETTER, not a value. The HTTP server and the input socket are both
// assigned after this is built -- one is still in its temporal dead zone, the other does not exist
// until the port is bound -- so reading them here would capture nothing.

/**
 * The deps for `createShutdown`, wired for this daemon.
 *
 * @param {{
 *   runner: object,
 *   stopView: () => void,
 *   inputSocket: () => {stop: () => Promise<unknown>}|null,
 *   servicePlugins: {stopAll: () => Promise<unknown>},
 *   closeHttpServer: () => void,
 *   clearOwned: () => void,
 *   exit: (code: number) => void,
 *   write: (line: string) => void,
 * }} parts
 */
export function daemonShutdownHooks({
  runner, stopView, inputSocket, servicePlugins, closeHttpServer, clearOwned, exit, write,
}) {
  return {
    runner,
    beforeStop: async () => {
      // THE VIEW STOPS FIRST, AND SYNCHRONOUSLY, because it owns the operator's TERMINAL and this
      // callback is awaited only up to a budget. `lib/daemon-view.mjs` carries the argument and the
      // measurement. A frame landing mid-teardown paints a screen that is already untrue.
      stopView();
      // THE INPUT SOCKET GOES HERE, where the wait is real. Closing a unix socket UNLINKS its path,
      // and `closeServer` below is deliberately never awaited -- so an unawaited stop finished
      // AFTER the successor had bound the same path, and deleted ITS socket file. The successor
      // went on advertising an address that no longer existed and every attach fell back to HTTP
      // until somebody restarted it. Observed by external review, 2026-09-21, finding F.
      await inputSocket()?.stop();
      // PLUGINS LAST OF THE THREE, but still before `runner.stop()`: one may be mid-claim, and a
      // claim settled after its processes are gone reports a spawn as running against a host that
      // no longer exists. `stopAll()` also sends the offline beat and the pending exit markers.
      await servicePlugins.stopAll();
    },
    // Stop ACCEPTING, so nothing new arrives mid-teardown. NOT awaited by the sequence, which is
    // why nothing whose completion matters may be started from here: an HTTP server with an open
    // SSE stream can take as long as that stream lives to finish closing.
    closeServer: () => { closeHttpServer(); },
    clearOwned,
    exit,
    write,
  };
}
