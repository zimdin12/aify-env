// Is this host WSL? Read from /proc, never from an environment variable.
//
// WHY IT IS NOT `WSL_DISTRO_NAME`. That variable is present in interactive shells and absent in many
// child processes, so the same machine answers differently depending on what launched the process.
// aify-comms paid for that on 2026-06-02: its machine_id derived the tag from the variable, one host
// registered as both `wsl-ubuntu:host` and `linux:host`, and a delivery loop could never claim runs
// for an agent recorded under the other spelling. Its `stablePlatformTag` reads /proc for that
// reason; this is the same predicate on this side of the seam, so the two tiers cannot drift.
//
// WHAT DEPENDS ON IT HERE: `machineId`, which the service arbitrates bridge supersession on, and
// `kind`, which the service joins into the environment id. Both were derived from the variable --
// `isWsl: kind === "wsl"` -- so a WSL host that did not inherit it advertised `linux:<host>` while
// the aify-comms bridge on the same machine advertised `wsl:<host>`.
//
// INJECTABLE, because `advertise.mjs` is pure by design and may not read a filesystem. The reader is
// a parameter so a test can pose a host without owning one.
import { readFileSync } from "node:fs";

export function hostIsWsl({ platform = process.platform, readFile = readFileSync } = {}) {
  if (platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(readFile("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    // unreadable -> not WSL. Fails closed: a host we cannot prove is WSL keeps its platform.
    return false;
  }
}
