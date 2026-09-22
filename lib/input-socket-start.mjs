// Bringing the local input socket up for a daemon that has just bound its port.
//
// A SEPARATE FILE because the entry point is the place where responsibilities go to hide: it crossed
// the 1000-line gate the moment this landed inline, which is the gate doing its job. What lives here
// is one decision -- whether this host wants a socket, where it goes, and what to do when it cannot
// be opened -- and all of it is testable without binding a port or starting a daemon.
//
// FAILING TO LISTEN IS NOT FAILING TO SERVE. Every path out of here leaves the daemon able to answer
// over HTTP, which is why the caller treats a null result as ordinary rather than as an error.
//
// AND FAILING TO LOCK IS FAILING TO LISTEN. A socket this user does not exclusively own is a
// keystroke channel into an agent's terminal, so anything short of 0600 ends with no socket and
// everyone on HTTP. That is a refusal to open one, never a refusal to serve.

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";

import { InputSocketServer, localSocketAddress, socketDirectory } from "./input-socket.mjs";

/** The mode a unix socket for one user's keystrokes may carry, and the only one. */
export const SOCKET_MODE = 0o600;

/**
 * Make the directory the socket will sit in, and prove it is this user's alone.
 *
 * VERIFIED, NOT ASSUMED: `mkdir` with a mode is subject to the umask and does nothing at all when the
 * directory already exists, so the mode asked for is not the mode obtained. The stat is what decides.
 */
function prepareDirectory({ dir, mkdir, stat }) {
  mkdir(dir, { recursive: true, mode: 0o700 });
  // THE ENTRY ITSELF, not what it points at. Following a link judged the TARGET, so a link planted at
  // the temp-root fallback by another account passed by aiming at a private directory of ours -- and
  // its owner could repoint it after the address was advertised, sending the next attach to them.
  const info = stat(dir);
  if (info.isSymbolicLink()) throw new Error(`${dir} is a symbolic link; the socket's directory must be a real one`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${dir} is mode ${(info.mode & 0o777).toString(8)}; a socket there is open to other accounts`);
  }
  const me = typeof process.getuid === "function" ? process.getuid() : null;
  if (me !== null && typeof info.uid === "number" && info.uid !== me) {
    throw new Error(`${dir} belongs to uid ${info.uid}, not ${me}`);
  }
  return dir;
}

/**
 * @returns {Promise<InputSocketServer|null>} the listening server, or null when this host has none.
 */
export async function startInputSocket({
  enabled, port, handleRequest, deps, log = () => {},
  platform = process.platform,
  // Injected so the platform branches are testable on any machine.
  // `lstat`, so neither the directory nor the socket read back is judged through a link.
  unlink = unlinkSync, chmod = chmodSync, stat = lstatSync, mkdir = mkdirSync,
  umask = (mode) => process.umask(mode),
  token = () => randomBytes(8).toString("hex"),
  dir, createServer = (options) => new InputSocketServer(options),
} = {}) {
  if (!enabled) return null;
  const posix = platform !== "win32";
  let address = "";
  let opened = null;
  let previousUmask = null;
  try {
    address = localSocketAddress({
      platform, port,
      dir: posix ? prepareDirectory({ dir: dir || socketDirectory({ platform }), mkdir, stat }) : dir,
      // Windows has no private directory to put this in, so the name carries the privacy instead.
      token: posix ? "" : token(),
    });
    // A unix socket is a FILE, and a stale one from a daemon that died refuses the bind. A Windows
    // named pipe has no such remains: it goes with the process that created it.
    if (posix) { try { unlink(address); } catch { /* nothing stale to remove */ } }
    // BORN LOCKED. Measured under WSL on 2026-09-21: bind at umask 022 gives mode 755, and the chmod
    // below only narrows it AFTERWARDS -- a window in which any account on the machine can connect
    // and type. The kernel applies the umask as the socket is created, which is the only way to have
    // no window at all. It is process-wide for the length of the bind, which is the cost: briefly too
    // private is the direction that fails safe.
    if (posix) previousUmask = umask(0o177);
    opened = await createServer({
      address, handleRequest, deps,
      onError: (error) => log(`[aify-env] input socket: ${error?.message ?? error}`),
    }).start();
    if (posix) { umask(previousUmask); previousUmask = null; }
    if (posix) {
      // Belt and braces for a platform where the umask did not apply, and THEN read back what the
      // file actually carries. A chmod whose failure is swallowed is how the first version advertised
      // a 755 socket on /health with nothing in any log -- observed, not supposed.
      chmod(address, SOCKET_MODE);
      const mode = stat(address).mode & 0o777;
      if (mode !== SOCKET_MODE) throw new Error(`${address} is mode ${mode.toString(8)}, not ${SOCKET_MODE.toString(8)}`);
    }
    return opened;
  } catch (error) {
    // Whatever went wrong, leave nothing half-open behind: a listening socket nobody knows about is
    // the exact thing this refuses to advertise.
    if (opened) { try { await opened.stop(); } catch { /* it is going away either way */ } }
    log(`[aify-env] input socket unavailable (${error?.message ?? error}); clients use HTTP`);
    return null;
  } finally {
    if (previousUmask !== null) umask(previousUmask);
  }
}
