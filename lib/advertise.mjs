// What this host can do, told to every service registered here.
//
// PURE, WITH THE NETWORK INJECTED -- the shape `services.mjs` already uses for its health knock:
// "Supplied by the caller rather than fetched here, so the decision is testable without a network".
// Every function below takes its inputs; nothing reads a clock, a filesystem or a socket.
//
// WHY THIS EXISTS. Advertising which runtimes a host can start was done by an aify-comms process
// running ON the host -- per service. A second service needed its own, and the two could disagree
// about one machine. aify-env already knows every input: the registry says who to tell, `/health`
// knows whether a terminal can be opened, and `allowlist.mjs` identifies wrappers by contract
// marker. See aify-comms `docs/ENVIRONMENT_ADVERTISEMENT.md` for the direction decision.
//
// THREE THINGS THIS DELIBERATELY DOES NOT SEND, each because the receiving tier owns it:
//
//   * `id`. The service joins `kind` + `hostname` itself. That string keys the SERVICE's table, and
//     an advertiser building it independently would agree the day it was written and mint a
//     DUPLICATE environment the first time either copy of the rule changed -- same host, same
//     runtimes, two rows, nothing raised.
//
//   * The runtime CAPABILITY flags. `nativeResume`, `interrupt`, `streaming`, `contextReset` and the
//     rest are statements about how a SERVICE drives a runtime, not facts about this host. Carrying
//     them would put aify-comms' semantics inside the tier whose README opens "Nothing here knows
//     what a message is, what a dispatch is, or whether an agent is thinking."
//
//   * Canonical runtime NAMES. This sends the client names it can see -- `claude`, `omp` -- not
//     `claude-code` or `pi`. `service/contracts/vocabulary.json` already owns that mapping in both
//     languages with an agreement test on each side; a third copy here is the drift this file is
//     written to avoid.
//
// What is left is exactly what a host can answer: which harnesses are installed, whether a terminal
// can be opened, where work may run, and who this machine is.

import { markerOf } from "./allowlist.mjs";

/** The launcher naming aify-wrapper renders: `wrappers/<client>-aify.sh.in`, one per harness. */
const LAUNCHER_SUFFIX = "-aify";

/**
 * Which harnesses aify-wrapper was installed for, derived from files rather than from a list.
 *
 * DERIVED, NOT LISTED -- `allowlist.mjs`'s own rule, applied to a second question. A file counts when
 * it carries the harness contract marker, so installing a wrapper for a new harness advertises it
 * with nobody editing anything, and a name that merely LOOKS like a launcher is not enough.
 *
 * IT IS THE WRAPPER, NOT THE RUNTIME. `claude` being on PATH says the binary exists; it does not say
 * this environment can start it as a managed agent. What aify-env spawns is `claude-aify`, so that is
 * the file whose presence is the honest claim.
 *
 * READ, NEVER RUN. Asking a launcher what it is by executing it is how a fleet went down: a
 * pre-contract wrapper forwards `--check` to the runtime and starts it.
 *
 * FAILS CLOSED. An entry whose text could not be read is absent, not present -- `markerOf` returns
 * null for anything that is not a string, and a probe that could not answer has not said yes.
 *
 * The first reachable copy of a name wins, matching how PATH itself resolves, so a stale launcher
 * later on PATH cannot mask the one that would actually run.
 *
 * @param {Array<{file: string, text: unknown}>} entries files already read, in PATH order
 * @returns {Array<{client: string, command: string, found: boolean, path: string}>}
 */
export function installedHarnesses(entries = []) {
  const seen = new Map();
  for (const entry of entries ?? []) {
    const file = String(entry?.file ?? "");
    const base = file.split(/[\\/]/).pop() ?? "";
    const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
    if (!stem.endsWith(LAUNCHER_SUFFIX)) continue;
    const client = stem.slice(0, -LAUNCHER_SUFFIX.length);
    if (client === "" || seen.has(client)) continue;
    if (markerOf(entry?.text) === null) continue;
    seen.set(client, { client, command: stem, found: true, path: file });
  }
  return [...seen.values()].sort((a, b) => a.client.localeCompare(b.client));
}

/**
 * This host's machine id, in the ONE format the service already compares.
 *
 * MIRRORED FROM `mcp/stdio/runtimes.js#defaultMachineId`, deliberately and exactly. The service uses
 * `machine_id` to arbitrate bridge supersession, so two producers disagreeing about one host does not
 * raise an error -- it makes the same machine look like two, and the arbitration silently stops
 * applying. An agreement test in the aify-comms bridge suite drives both implementations over the
 * same inputs, because a comment saying "kept in step" is not a mechanism.
 *
 * `wsl` IS NOT A PLATFORM but it is the tag, because a WSL host and the Windows host beside it share
 * a hostname and would otherwise collide on one id. The host name comes from the environment first
 * for the same reason the bridge reads it there: `os.hostname()` disagrees with `COMPUTERNAME` on
 * some launch paths, and the id has to survive a relaunch from a different shell.
 *
 * @param {{platform?: string, hostname?: string, env?: object, isWsl?: boolean}} facts
 * @returns {string} lowercased `<tag>:<host>`
 */
export function machineIdFor({ platform = "", hostname = "", env = {}, isWsl = false } = {}) {
  const host = String(
    env.AIFY_MACHINE_ID || env.COMPUTERNAME || env.HOSTNAME || hostname || "",
  ).trim() || "unknown-host";
  const tag = platform === "linux" && isWsl ? "wsl" : String(platform || "");
  return `${tag}:${host}`.toLowerCase();
}

/** The `wsl` / `docker` / `windows` / `macos` / `linux` this host is. */
export function environmentKind({ platform, env = {}, exists = () => false } = {}) {
  const explicit = String(env.AIFY_ENVIRONMENT_KIND || "").trim();
  if (explicit) return explicit;
  if (env.WSL_DISTRO_NAME) return "wsl";
  if (env.container || exists("/.dockerenv")) return "docker";
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

/** The operating system, which is NOT the kind: a wsl or docker host still runs linux. */
export function environmentOs(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

/**
 * `detectHarnesses` rows reduced to what a host can claim.
 *
 * FAILS CLOSED, inheriting the detector's own rule: a probe that could not answer has not said yes.
 * `found` is only ever true when a path came back, so an unreadable PATH advertises nothing rather
 * than advertising everything.
 *
 * The REASON travels with the negative. "not found on PATH" is what an operator acts on; a bare
 * `available: false` sends them looking at the service.
 */
export function runtimeAvailability(harnessRows = []) {
  return [...harnessRows]
    .map((row) => ({
      runtime: String(row?.client ?? row?.command ?? "").trim(),
      available: row?.found === true,
      unavailableReason: row?.found === true ? "" : `${row?.command ?? "runtime"} not found on PATH`,
    }))
    .filter((row) => row.runtime !== "")
    .sort((a, b) => a.runtime.localeCompare(b.runtime));
}

/**
 * The body of a heartbeat, with no `id` and no capability flags.
 *
 * `hostname` is sent RAW. The service joins it into `${kind}:${hostname}:default`, and the live rows
 * were written from a raw `os.hostname()` -- lowercasing here would mint a new id for every existing
 * environment and orphan the agents bound to the old one.
 */
export function environmentAdvertisement({
  hostname,
  kind,
  os,
  machineId,
  label,
  cwdRoots,
  runtimes = [],
  terminal = false,
  terminalReason = "",
  version = "",
  instance = "",
} = {}) {
  return {
    hostname: String(hostname || ""),
    kind: String(kind || ""),
    os: String(os || ""),
    machineId: String(machineId || ""),
    label: String(label || ""),
    // OMITTED WHEN THIS HOST HAS NOTHING TO SAY, and that is a claim rather than a gap. The service
    // reads an absent `cwdRoots` as "keep what you have" and an EMPTY ARRAY as "there are none", so
    // an advertiser that always sent `[]` would erase the operator's configured roots on every beat.
    // Which directories work may run in is the service's policy, set in its dashboard; this tier
    // knows processes, not permissions.
    ...(cwdRoots === undefined ? {} : { cwdRoots: [...cwdRoots] }),
    runtimes,
    terminalRuntimes: runtimes.filter((row) => row.available).map((row) => row.runtime),
    terminal: !!terminal,
    pty: !!terminal,
    metadata: { advertiser: "aify-env", version: String(version || ""), instance: String(instance || ""), terminalReason: String(terminalReason || "") },
  };
}

/**
 * A stable string over the fields a re-detection could change.
 *
 * ITS JOB IS TO SKIP DETECTION, NOT TRANSMISSION. `detectHarnesses` walks PATH and stats candidates;
 * the payload is a few hundred bytes. So this answers "did anything change since the last walk",
 * and the beat is sent regardless. An earlier draft of the design had the service storing this and
 * negotiating for the full document -- a protocol built to save fewer bytes than its own headers.
 *
 * Deliberately excludes `instance` and anything time-varying: a fingerprint that changes every beat
 * would report a re-detection on every beat, which is the opposite of the point.
 */
export function capabilityFingerprint(advertisement = {}) {
  const runtimes = (advertisement.runtimes || [])
    .map((row) => `${row.runtime}:${row.available ? 1 : 0}:${row.unavailableReason || ""}`)
    .sort()
    .join("|");
  const roots = [...(advertisement.cwdRoots || [])].sort().join("|");
  return [
    advertisement.hostname || "",
    advertisement.kind || "",
    advertisement.os || "",
    advertisement.machineId || "",
    advertisement.terminal ? "pty" : "no-pty",
    roots,
    runtimes,
  ].join("");
}

/** Whether the PATH walk is due again. Pure: the clock is an argument. */
export function shouldRedetect({ lastDetectedAt = 0, now = 0, intervalMs = 300000 } = {}) {
  if (!Number.isFinite(lastDetectedAt) || lastDetectedAt <= 0) return true;
  if (!Number.isFinite(now)) return false;
  return now - lastDetectedAt >= intervalMs;
}

/**
 * Where a heartbeat goes for each registered service.
 *
 * The endpoint is the service's own; `/api/v1` is aify-comms' mount and travels with the path rather
 * than being baked into the registry, so a service that mounts elsewhere is a registry change and
 * not a code change here.
 */
export function advertisementTargets(services = []) {
  return services
    .map((service) => String(service?.endpoint || "").replace(/\/+$/, ""))
    .filter(Boolean)
    .map((endpoint) => `${endpoint}/api/v1/environments/heartbeat`);
}

/**
 * POST the body to every target, reporting per-target outcomes and NEVER throwing.
 *
 * A service being down is not this daemon's failure. aify-env's own words for the health knock:
 * "it knocks, and it reports what came back -- including 'nothing came back', which is its own
 * answer and not a failure." One unreachable service must not stop the others being told.
 */
export async function advertiseTo({ targets = [], body = {}, post } = {}) {
  const results = [];
  for (const url of targets) {
    try {
      const response = await post(url, body);
      const status = Number(response?.status ?? 0);
      results.push({ url, ok: status >= 200 && status < 300, status, error: "" });
    } catch (error) {
      results.push({ url, ok: false, status: 0, error: String(error?.message || error) });
    }
  }
  return results;
}
