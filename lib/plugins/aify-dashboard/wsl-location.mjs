// The WSL location facts agreed with aify-dashboard's registration resolver. Read on the host,
// not from a watch-list row or a distro name. See docs/watch-list-locations-v1.md.
import { readFileSync } from "node:fs";
import { withinWatchRoots } from "../../watch-roots.mjs";

const DISTRO_ID = /^[0-9a-zA-Z._-]{8,128}$/;
const MOUNT_ESCAPES = Object.freeze({ "040": " ", "011": "\t", "012": "\n", "134": "\\" });

export function wslNamespace(distroId) {
  return typeof distroId === "string" && DISTRO_ID.test(distroId) ? `wsl:${distroId}` : null;
}

function driveMountsFrom(text) {
  return text.split("\n").flatMap(line => {
    const [, mount, type, options] = line.trim().split(/\s+/);
    if (!mount || (type !== "9p" && type !== "drvfs") || !/(^|[;,])aname=drvfs([;,]|$)/.test(options ?? "")) return [];
    const drive = /(?:^|[;,])path=([A-Za-z]):\\(?:[;,]|$)/.exec(options)?.[1];
    return drive ? [{ mountPoint: mount.replace(/\\(040|011|012|134)/g, (_, code) => MOUNT_ESCAPES[code]), drive: drive.toUpperCase() }] : [];
  });
}

/** Missing identity or unreadable mount facts cannot distinguish this distro's paths from Windows. */
export function readWslLocation({ readFile = readFileSync } = {}) {
  try {
    const distroId = readFile("/etc/machine-id", "utf8").trim();
    if (!wslNamespace(distroId)) return null;
    const mounts = readFile("/proc/mounts", "utf8");
    if (mounts.trim() === "") return null;
    return { distroId, driveMounts: driveMountsFrom(mounts) };
  } catch {
    return null;
  }
}

export function isWindowsMountPath(path, wsl) {
  return wsl != null && withinWatchRoots(path, wsl.driveMounts.map(mount => mount.mountPoint), "linux");
}
