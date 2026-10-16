// The environment a test daemon may be started with.
//
// ADVERTISING IS ON BY DEFAULT SINCE 2026-08-30, which is correct for a real host and wrong for a
// test. A daemon spawned by a test inherits the machine's real `~/.aify/services.json`, finds the
// operator's aify-comms in it, and posts this host's runtimes and terminal state to the LIVE service
// -- describing a host from a process that exists for two seconds.
//
// THAT IS NOT HYPOTHETICAL IN THIS PROJECT. A "hostile environment" suite run once pointed at the
// operator's real service and registered six agents into their production registry, and a test that
// set an ACTION flag rather than a config one became the environment bridge and reaped seven live
// gateway hosts. A test may set a variable that says where to look; it must not set one that makes
// something happen.
//
// SEALED, NOT REDIRECTED. `AIFY_ADVERTISE=0` says "this daemon describes nobody", which is the honest
// state for a process that is about to be killed. A test that is ABOUT advertising points
// `AIFY_SERVICE_REGISTRY` at a fake service instead and turns it back on deliberately -- see
// `the-daemon-really-advertises.test.js`.
//
// AND THE REGISTRY SEAL WAS THE OPPOSITE OF A SEAL, measured 2026-09-03 on the operator's host. This
// set `AIFY_SERVICE_REGISTRY` to the EMPTY STRING, with a comment saying an empty path "resolves to
// nothing readable rather than to the operator's real one". `bin/aify-env.mjs` reads
// `process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json")` -- and `""` is
// FALSY, so the seal SELECTED the file it was written to exclude. Every test daemon read the
// operator's real registry, found the live aify-comms, and claimed against production:
// `windows:StevenZ-L:default` changed hands and the operator's own aify-env spent minutes answering
// "not the claimer", unable to take a new spawn.
//
// ADVERTISING OFF IS NOT CLAIMING OFF, which is why `AIFY_ADVERTISE=0` did not save it. The doctor
// documents that distinction in its own words -- "ADVERTISING AND CLAIMING ARE DIFFERENT
// CAPABILITIES" -- and a plugin loaded from a registry claims whether or not it describes the host.
// Sealing the registry is what stops a test daemon FINDING a service to claim, so that is the seal
// that has to hold.
//
// A PATH THAT DOES NOT EXIST, never an empty one. Empty means "unset" to every `||` default in this
// codebase, and "unset" is the operator's home directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A path no registry lives at, so a daemon that reads it finds no services and claims nothing. Under the test temp
 * directory, never the inherited AIFY_SERVICE_REGISTRY: a private home does not fence an absolute registry a shell
 * set, and that registry would start a test daemon's plugins against the services it names (review of B1, 2026-10-17).
 */
export const NO_REGISTRY = path.join(os.tmpdir(), "aify-tests-no-such-registry", "services.json");

// AND THE HOME IS SEALED, measured 2026-10-14. A daemon resolves `~/.aify` through `os.homedir()`, which on Windows
// reads USERPROFILE, and a test that spread `process.env` inherited whatever home its process had. Under
// tests/run-in-a-temp-root.mjs that is a private temp home; run directly with `node --test`, it is the operator's
// own. `the-daemon-really-advertises.test.js`, run that way, booted daemons that rewrote the real
// `~/.aify/env/default.json` and `default.generation` and took the real home's residents role. So every daemon
// env goes through `sealedHomeEnv`, which keeps a home only when it is private and otherwise substitutes one.

/** The operator's own home, from the OS account, never from a variable a test or a runner may have set. */
export const REAL_HOME = path.resolve(os.userInfo().homedir);

/** A home a test daemon may use: set, under the temp directory, and not the operator's own. */
export function isPrivateHome(dir) {
  if (typeof dir !== "string" || !dir.trim()) return false;
  const home = path.resolve(dir), temp = path.resolve(os.tmpdir());
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (fold(home) === fold(REAL_HOME)) return false;
  return fold(home).startsWith(fold(temp) + path.sep);
}

let processHome = null;
/** One private home for every daemon this test process starts outside the runner's, made on first use. */
function privateHome() {
  processHome ??= fs.mkdtempSync(path.join(os.tmpdir(), "aify-sealed-home-"));
  return processHome;
}

/**
 * `env` with HOME and USERPROFILE both pointing at one private home: its own when both already are, else this
 * process's. Throws when the result could still resolve the operator's home, so a seal that regresses fails here.
 */
export function sealedHomeEnv(env) {
  const own = isPrivateHome(env.HOME) && isPrivateHome(env.USERPROFILE) ? env.USERPROFILE : privateHome();
  const sealed = { ...env, HOME: own, USERPROFILE: own };
  if (!isPrivateHome(sealed.HOME) || !isPrivateHome(sealed.USERPROFILE)) {
    throw new Error(`a test daemon's home is not private: HOME=${sealed.HOME} USERPROFILE=${sealed.USERPROFILE}`);
  }
  return sealed;
}

/**
 * `process.env` plus the seals every spawned daemon needs, and nothing else.
 *
 * @param {object} [extra] per-test additions, applied last so a test can deliberately re-enable
 */
export function sealedDaemonEnv(extra = {}) {
  return sealedHomeEnv({
    ...process.env,
    // Say nothing to anyone. A test daemon has no host to describe.
    AIFY_ADVERTISE: "0",
    // And if a test turns advertising back on, it must also say WHERE. Pointed at a path that does
    // not exist rather than emptied: `||` reads empty as unset and falls back to the operator's own
    // `~/.aify/services.json`, which is the file this line exists to keep out. And never the inherited value: a test
    // that needs a registry passes it in `extra`.
    AIFY_SERVICE_REGISTRY: NO_REGISTRY,
    // The view writes escapes into captured output and slows every assertion that reads it.
    AIFY_NO_DASHBOARD: "1",
    ...extra,
  });
}
