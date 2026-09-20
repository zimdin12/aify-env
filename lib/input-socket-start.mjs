// Bringing the local input socket up for a daemon that has just bound its port.
//
// A SEPARATE FILE because the entry point is the place where responsibilities go to hide: it crossed
// the 1000-line gate the moment this landed inline, which is the gate doing its job. What lives here
// is one decision -- whether this host wants a socket, where it goes, and what to do when it cannot
// be opened -- and all of it is testable without binding a port or starting a daemon.
//
// FAILING TO LISTEN IS NOT FAILING TO SERVE. Every path out of here leaves the daemon able to answer
// over HTTP, which is why the caller treats a null result as ordinary rather than as an error.

import { chmodSync, unlinkSync } from "node:fs";

import { InputSocketServer, localSocketAddress } from "./input-socket.mjs";

/**
 * @returns {Promise<InputSocketServer|null>} the listening server, or null when this host has none.
 */
export async function startInputSocket({
  enabled, port, handleRequest, deps, log = () => {},
  platform = process.platform,
  // Injected so the platform branches are testable on any machine.
  unlink = unlinkSync, chmod = chmodSync, createServer = (options) => new InputSocketServer(options),
} = {}) {
  if (!enabled) return null;
  const address = localSocketAddress({ platform, port });
  try {
    // A unix socket is a FILE, and a stale one from a daemon that died refuses the bind. A Windows
    // named pipe has no such remains: it goes with the process that created it.
    if (platform !== "win32") { try { unlink(address); } catch { /* nothing stale to remove */ } }
    const server = await createServer({
      address, handleRequest, deps,
      onError: (error) => log(`[aify-env] input socket: ${error?.message ?? error}`),
    }).start();
    // ONLY THIS USER. A socket anyone on the machine can open types into an agent's terminal. A
    // Windows named pipe inherits the creating token's default DACL, which already excludes other
    // users; a unix socket is created world-writable unless this is set.
    if (platform !== "win32") { try { chmod(address, 0o600); } catch { /* best effort, see below */ } }
    return server;
  } catch (error) {
    log(`[aify-env] input socket unavailable (${error?.message ?? error}); clients use HTTP`);
    return null;
  }
}
