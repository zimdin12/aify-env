// Compute the host identifier from already observed facts. No I/O.
export function machineIdFor({ platform = "", hostname = "", env = {}, isWsl = false } = {}) {
  const host = String(
    env.AIFY_MACHINE_ID || env.COMPUTERNAME || env.HOSTNAME || hostname || "",
  ).trim() || "unknown-host";
  const tag = platform === "linux" && isWsl ? "wsl" : String(platform || "");
  return `${tag}:${host}`.toLowerCase();
}
