// Which aify home this is, and the names every party derives from it for the residents role (B1 contract items 1-3).
//
// PURE, apart from the one `realpath` the caller injects. The home is `<os home>/.aify`; its identity is that
// directory's real path, resolved by the OS (`realpathSync.native` resolves junctions and 8.3 names on Windows), and
// folded to lower case on Windows, where two spellings differing only in case name one directory. Everything the role
// is called by is derived from that identity, never listed:
//   homeIdentity               the directory's identity, or the reason it has none
//   crossOsHomeReason          why a home shared across operating systems cannot hold the role, or ""
//   roleEndpoint               the lock: a Windows named pipe or a Linux abstract socket, or null where neither exists
//   residentsPublisherInstance the C5 publisher instance the role publishes under: home-qualified, stable across holders
//
// THREE NAMES, KEPT APART. `residents` (RESIDENTS) is the local logical role: the files under `~/.aify/env/` and the
// instance a resident record and its hooks carry. `residents-<hash12>` is the WIRE publisher instance, because a
// machine id does not name a home and two homes on one machine would otherwise share one publisher key (contract
// item 6). A daemon's own managed instance (`default`, or a dedicated `herdr-<invocation>`) is a third name.

import { createHash } from "node:crypto";
import path from "node:path";

/** The local role name: its files, and the instance its resident records and hooks carry. */
export const RESIDENTS = "residents";

/** The aify home under an OS home directory. No override: `AIFY_HOME` is out of this slice (contract item 1). */
export function aifyHomeOf(osHome) {
  return path.join(osHome, ".aify");
}

const digest = (identity) => createHash("sha256").update(identity, "utf8").digest("hex");

/**
 * @param {string} dir  the aify home as some spelling of it
 * @param {{platform: string, realpath: (p: string) => string}} io
 * @returns {{ok: true, identity: string} | {ok: false, reason: string}}
 */
export function homeIdentity(dir, { platform, realpath }) {
  let real;
  try { real = realpath(dir); } catch (error) { return { ok: false, reason: `home-unresolvable: ${error?.code || "error"}` }; }
  if (typeof real !== "string" || !real) return { ok: false, reason: "home-unresolvable: empty" };
  return { ok: true, identity: platform === "win32" ? real.toLowerCase() : real };
}

/**
 * A home the OS lock cannot exclude across: WSL on a drvfs or 9p mount, or Windows on a `\\wsl$` share. The lock is
 * per OS, so two daemons on either side could each hold it for one directory (contract item 1). On Linux the mount
 * points are refused whether or not this host proves it is WSL: a Linux home under `/mnt/c` that is not a Windows
 * drive is unusual, and refusing it costs a reported missing role, where admitting a shared one costs two owners.
 *
 * @returns {string} the reason, or "" when the home may hold the role
 */
export function crossOsHomeReason(identity, { platform }) {
  const text = String(identity);
  if (platform === "win32") {
    const folded = text.toLowerCase().split("/").join("\\");
    if (folded.startsWith("\\\\wsl$\\") || folded.startsWith("\\\\wsl.localhost\\")) return "cross-os-home: a WSL share";
    return "";
  }
  if (platform === "linux" && /^\/mnt\/(?:[a-z]|wsl)(?:\/|$)/i.test(text)) return "cross-os-home: a Windows drive or shared WSL mount";
  return "";
}

/**
 * The role's lock endpoint. Null on a platform this slice does not qualify (macOS and the rest): the role is then
 * refused, never approximated (contract item 3).
 */
export function roleEndpoint(identity, platform) {
  const name = `aify-residents-${digest(identity).slice(0, 16)}`;
  if (platform === "win32") return `\\\\.\\pipe\\${name}`;
  if (platform === "linux") return `\0${name}`;
  return null;
}

/** The residents' C5 publisher instance: the home is in the key, so two homes on one machine are two publishers. */
export function residentsPublisherInstance(identity) {
  return `${RESIDENTS}-${digest(identity).slice(0, 12)}`;
}
