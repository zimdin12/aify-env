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

/**
 * Is this daemon advertising host facts to anyone?
 *
 * THE BRIDGE STANDS DOWN ON THIS, so it has to mean "somebody is being told", not "somebody could be".
 * Armed but with no target is the case that would strand the row: the bridge would omit host facts
 * believing they were covered, and nothing would send them.
 *
 * @param {{enabled?: boolean, targets?: unknown[]}} state
 */
export function isAdvertising({ enabled = false, targets = [] } = {}) {
  return enabled === true && Array.isArray(targets) && targets.length > 0;
}

/**
 * Whether the advertiser is switched on, from the environment.
 *
 * DEFAULT-ON since the bridge learned to stand down. It was opt-in only while both tiers could
 * advertise at once, and an explicit `0`/`false`/`no` still hands the job back to the bridge.
 */
export function advertisingEnabled(value) {
  return !["0", "false", "no", "off"].includes(String(value ?? "").trim().toLowerCase());
}

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
/**
 * What this host IS: its kind, its os, and its machine id, from one set of inputs.
 *
 * THESE THREE TRAVEL TOGETHER because two of them are joined by the service -- `kind` into the
 * environment id, `machineId` into bridge supersession -- and a host that answers them
 * inconsistently registers as two environments with nothing raised.
 *
 * IT EXISTS BECAUSE THEY WERE DERIVED FROM EACH OTHER. The call site read `isWsl: kind === "wsl"`,
 * so the machine id inherited whatever the kind had concluded from an environment variable. Fixing
 * the derivation would have left the next caller free to re-create it; taking `isWsl` ONCE and
 * answering all three from it makes that shape unavailable rather than merely corrected.
 *
 * @param {{platform?: string, hostname?: string, env?: object, exists?: Function, isWsl?: boolean}} facts
 */
export function hostIdentityFacts({
  platform = "", hostname = "", env = {}, exists = () => false, isWsl = false,
} = {}) {
  const kind = environmentKind({ platform, env, exists, isWsl });
  return {
    kind,
    os: environmentOs(platform),
    machineId: machineIdFor({ platform, hostname, env, isWsl }),
  };
}

export function machineIdFor({ platform = "", hostname = "", env = {}, isWsl = false } = {}) {
  const host = String(
    env.AIFY_MACHINE_ID || env.COMPUTERNAME || env.HOSTNAME || hostname || "",
  ).trim() || "unknown-host";
  const tag = platform === "linux" && isWsl ? "wsl" : String(platform || "");
  return `${tag}:${host}`.toLowerCase();
}

/** The `wsl` / `docker` / `windows` / `macos` / `linux` this host is. */
export function environmentKind({ platform, env = {}, exists = () => false, isWsl = false } = {}) {
  const explicit = String(env.AIFY_ENVIRONMENT_KIND || "").trim();
  if (explicit) return explicit;
  if (env.WSL_DISTRO_NAME) return "wsl";
  if (env.container || exists("/.dockerenv")) return "docker";
  // A WSL HOST THAT DID NOT INHERIT THE VARIABLE, answered by `lib/host-wsl.mjs` and passed in.
  // Everything above is unchanged deliberately: an explicit kind wins and WSL beats container, both
  // declared and tested, and letting the file signal speak earlier would relabel a docker container
  // running ON WSL2 as `wsl` -- the WSL2 kernel says "microsoft" in osrelease inside the container
  // too. Here it can only answer a case that currently answers `linux`.
  if (isWsl) return "wsl";
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
  cwdRoots,
  runtimes = [],
  terminal = false,
  terminalReason = "",
  version = "",
  instance = "",
  //: WHAT IS ON DISK, beside `instance` which is what this process LOADED. Undefined when the
  //: caller cannot compute it, so the field is omitted rather than sent wrong -- an older
  //: daemon simply does not carry it and a reader treats its absence as "cannot tell".
  codeOnDisk,
} = {}) {
  return {
    hostname: String(hostname || ""),
    kind: String(kind || ""),
    os: String(os || ""),
    machineId: String(machineId || ""),
    // NO LABEL, for the same reason as `cwdRoots` below: it is the operator's chosen name for this
    // machine, not a fact about it. This tier would generate "windows on StevenZ-L" and overwrite a
    // "Windows on StevenZ-L" somebody typed -- a cosmetic regression on every beat. The service
    // preserves a label a caller does not mention.
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
    // `instance` IS WHAT IS RUNNING and `codeOnDisk` IS WHAT IS ON DISK, computed the same way so
    // the two are comparable by construction. Equal means current; different means this daemon is
    // running code its own package has moved past -- the question an operator restarting to pick
    // up a fix is actually asking, and one that previously needed a human to run a command and
    // compare two hashes by eye. Both travel rather than a boolean: a bare "restart me" with no
    // identities is unarguable, and the reader computes the verdict.
    metadata: {
      advertiser: "aify-env",
      version: String(version || ""),
      instance: String(instance || ""),
      // `null` AS WELL AS UNDEFINED. `PackageBuild` answers null when it could not read the
      // package at all, and that absence must stay an absence: an empty string here would compare
      // unequal to every instance and report a healthy host as needing a restart.
      ...(codeOnDisk === undefined || codeOnDisk === null ? {} : { codeOnDisk: String(codeOnDisk) }),
      terminalReason: String(terminalReason || ""),
    },
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
  // THE NAME IS KEPT, and that is the point. This used to return bare URLs, which made "am I
  // advertising?" a question only answerable for the daemon as a whole -- so a success to service B
  // counted as advertising to service A, and A's bridge stood down for a beat it never received.
  // The registry key is the identity the asker knows itself by, so it travels with the endpoint.
  return services
    .map((service) => ({
      name: String(service?.name || "").trim(),
      endpoint: String(service?.endpoint || "").replace(/\/+$/, ""),
      // Carried through the first map, not read off it afterwards. Rebuilding the object here and
      // reading `keyEnv` from the REBUILT one silently produced an empty list for every service,
      // which reads exactly like "this service declares no key".
      keyEnv: Array.isArray(service?.keyEnv)
        ? service.keyEnv.filter((name) => typeof name === "string" && name.trim() !== "")
        : [],
      // Carried for the same reason and with the same trap: read off the REBUILT object below it
      // would be undefined for every service, which reads exactly like "this service stores no
      // credential" -- and that is the state the whole carrier exists to stop being invisible.
      credentialRef: String(service?.credentialRef || ""),
    }))
    .filter((service) => service.endpoint !== "")
    .map((service) => ({
      name: service.name,
      url: `${service.endpoint}/api/v1/environments/heartbeat`,
      keyEnv: service.keyEnv,
      credentialRef: service.credentialRef,
    }));
}

/**
 * How many beats may be missed before a target counts as no longer advertised to.
 *
 * DERIVED from the beat interval rather than written as its own number: a standalone constant would
 * drift the moment somebody tuned the interval, and the two only mean anything together.
 */
/**
 * The credential for one target, resolved from THIS process's environment by the names the registry
 * declares. Returns "" when there is none, which is a supported configuration.
 *
 * WHY THIS EXISTS. `postAdvertisement` sent no key at all, so the moment an operator turned
 * `API_KEY` on, every advertisement 401'd -- and, before the acceptance fix, the daemon reported
 * `advertising: true` through all of it while the aify-comms bridge stood down. The two halves are
 * one blocker: one stops a refusal being read as success, this one stops the refusal happening.
 *
 * NAMES, NOT VALUES, and the registry is why. It is a shared file readable by everything on the
 * host, so it declares WHERE a key lives and never what it is. First non-empty name wins, matching
 * the order the service's own reader uses.
 *
 * PURE: the environment is passed in.
 */
export function credentialFor(target, env = {}) {
  for (const name of Array.isArray(target?.keyEnv) ? target.keyEnv : []) {
    const value = String(env?.[name] ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}

/**
 * The key an acceptance is recorded under: the SERVICE and the endpoint together.
 *
 * URL ALONE IS NOT AN IDENTITY. Acceptance was keyed by url while health was keyed by service name,
 * so two registry names pointing at one endpoint shared a single stamp -- service A could get a 2xx
 * and service B a 401, and BOTH rendered fresh because both read the same entry. They can carry
 * different credentials, so that is not a hypothetical: it is exactly the case where one succeeds
 * and the other does not.
 *
 * Both parts are in the key, so a change to EITHER invalidates: a service renamed, or one whose
 * endpoint moved, has no acceptance under its new identity and is correctly not-fresh until it gets
 * one.
 *
 * COLLISION-FREE BY CONSTRUCTION, not by assumption. The first version joined the two with a
 * newline and asserted in a comment that neither part could contain one. Nothing validates a
 * registry key or an endpoint against newlines, so that was a guarantee claimed rather than held --
 * the same shape as a guard that documents its rule instead of enforcing it. `JSON.stringify` of a
 * tuple encodes both lengths and escapes the contents, so no two distinct `{name, url}` pairs can
 * collapse onto one key whatever either happens to contain.
 */
export function acceptanceKey({ name = "", url = "" } = {}) {
  return JSON.stringify([String(name), String(url)]);
}

export const MISSED_BEATS_BEFORE_STALE = 3;

export function advertisementStaleMs(intervalMs) {
  return Math.max(1, Number(intervalMs) || 0) * MISSED_BEATS_BEFORE_STALE;
}

/**
 * Which services this daemon is CURRENTLY describing, judged on accepted beats.
 *
 * THE DEFECT THIS REPLACES. `isAdvertising` was `enabled && targets.length > 0` and consulted no
 * result at all, so a target answering 401, 404, 500 or nothing still reported `advertising: true`.
 * The aify-comms bridge stands down on that flag, so a service that never received a single
 * advertisement could be left described by NOBODY -- while both tiers reported healthy. The daemon's
 * own note beside the flag already said the answer "cannot say somebody is being told while the beat
 * posts to nobody"; it guarded the zero-target case and not the refused-beat case.
 *
 * PURE. `acceptedAt` is a Map of target url -> epoch ms of the last 2xx, `now` and `staleMs` are
 * supplied, and nothing here reads a clock or a socket.
 *
 * @returns {{advertising: boolean, services: Record<string, {url: string, acceptedAt: number, fresh: boolean}>}}
 */
export function advertisementHealth({
  enabled = false, targets = [], acceptedAt = new Map(), now = 0, staleMs = 0,
} = {}) {
  const services = {};
  for (const target of Array.isArray(targets) ? targets : []) {
    const url = String(target?.url || "");
    if (!url) continue;
    const at = Number(acceptedAt?.get?.(acceptanceKey(target)) || 0);
    // A beat that has NEVER been accepted is not stale, it is absent -- and both mean "not
    // advertising to this service". Freshness requires a real acceptance inside the window.
    const fresh = enabled === true && at > 0 && (now - at) >= 0 && (now - at) <= staleMs;
    services[String(target?.name || url)] = { url, acceptedAt: at, fresh };
  }
  return {
    advertising: Object.values(services).some((service) => service.fresh),
    services,
  };
}

/**
 * Which advertisement targets this daemon holds a credential for -- as a BOOLEAN, never a value.
 *
 * WHY THIS IS REPORTED AT ALL. The daemon's credential comes from its own process environment, under
 * the names the registry declares. Nothing on this host puts it there: the aify-comms bridge does not
 * start this daemon (its doctor says "Start aify-env on this host"), so the key is present only if
 * whoever launched it exported one. When the service has `API_KEY` set and this daemon has none,
 * every advertisement is refused, `advertising` stays false, and the bridge correctly keeps
 * describing the host -- which is SAFE and completely silent. The operator sees a daemon that runs,
 * answers `/health`, and is simply never believed.
 *
 * So the missing credential is made VISIBLE rather than inferred from a symptom three components
 * away. `aify-env doctor` reads this and names the environment variables to set.
 *
 * NAMES AND A BOOLEAN ONLY. `keyEnv` is already public -- it lives in a shared registry readable by
 * everything on the host -- and whether a variable is set is not the variable. No caller gets a
 * length, a prefix, or a hash: each of those narrows a search that the boolean does not.
 *
 * PURE: the environment is passed in.
 */
export function credentialReadiness(targets = [], env = {}) {
  const out = {};
  for (const target of Array.isArray(targets) ? targets : []) {
    const url = String(target?.url || "");
    if (!url) continue;
    const keyEnv = Array.isArray(target?.keyEnv) ? target.keyEnv.slice() : [];
    out[String(target?.name || url)] = {
      keyEnv,
      hasCredential: credentialFor(target, env) !== "",
    };
  }
  return out;
}

/**
 * Does this failed beat mean the standing acceptance must be dropped NOW?
 *
 * ONLY WHEN THE SERVICE SAID THE CREDENTIAL IS WRONG. A 401 or 403 is that answer. Anything else --
 * a 500, an unreachable host, a beat not yet attempted -- says nothing about the key, and revoking
 * on those would hand the description job back to the bridge every time somebody restarted a service.
 *
 * WHY IMMEDIATE RATHER THAN LETTING IT AGE. Between a key being rotated and the old acceptance
 * expiring, this daemon would keep reporting `advertising: true` for that service while every beat
 * was being refused -- so the aify-comms bridge would stay stood down and the host would be
 * described by NOBODY for the length of the staleness window. That is the outage the standdown fix
 * exists to prevent, arriving through the fix for it.
 *
 * PURE.
 */
export function revokesAcceptance(result) {
  if (!result || result.ok === true) return false;
  const status = Number(result.status || 0);
  return status === 401 || status === 403;
}

/**
 * The last beat OUTCOME per service name, keyed the way acceptance is.
 *
 * `acceptedBeats` records only 2xx, on purpose -- a refusal must never look like an acceptance. But
 * that leaves "not being heard" as ONE state covering two different situations with different
 * owners: a service that is DOWN is somebody else's outage, and a service that REFUSED our
 * credential is a key to set here. Reporting them alike is how a doctor row blames the wrong thing.
 *
 * `status` 0 with an `error` is a connection that never got an answer; a real HTTP status is an
 * answer we did not like. That distinction is the whole point of keeping this.
 *
 * NO RESPONSE BODY. A service's error text is its own and could carry anything, including something
 * it should not have said. A status number and this daemon's own transport error are enough.
 *
 * PURE.
 */
export function attemptsByService(targets = [], attempts = new Map()) {
  const out = {};
  for (const target of Array.isArray(targets) ? targets : []) {
    const url = String(target?.url || "");
    if (!url) continue;
    const seen = attempts?.get?.(acceptanceKey(target)) || null;
    out[String(target?.name || url)] = seen
      ? {
        at: Number(seen.at || 0), ok: seen.ok === true,
        status: Number(seen.status || 0), error: String(seen.error || ""),
      }
      // NEVER ATTEMPTED is not a failed attempt. A daemon that has not beaten yet has gathered no
      // evidence about this service, and a zeroed row would read as one that tried and got nothing.
      : null;
  }
  return out;
}

/**
 * Is this daemon advertising to ONE named service?
 *
 * The question the aify-comms bridge actually has. Asking the daemon-wide flag makes a success to
 * any other service stand this one down.
 */
export function advertisingToService(health, serviceName) {
  const entry = health?.services?.[String(serviceName || "")];
  return entry?.fresh === true;
}

/**
 * POST the body to every target, reporting per-target outcomes and NEVER throwing.
 *
 * A service being down is not this daemon's failure. aify-env's own words for the health knock:
 * "it knocks, and it reports what came back -- including 'nothing came back', which is its own
 * answer and not a failure." One unreachable service must not stop the others being told.
 */
export async function advertiseTo({
  targets = [], body = {}, post, env = {}, credential = null,
} = {}) {
  const results = [];
  for (const target of targets) {
    // Targets carry their registry name so a result can be attributed to the service that owns it.
    const url = typeof target === "string" ? target : String(target?.url || "");
    const name = typeof target === "string" ? "" : String(target?.name || "");
    try {
      // The key travels as an ARGUMENT, so `post` stays injectable and nothing here reads a real
      // environment. A target with no declared names, or names nothing set, sends none.
      // THE RESOLVER IS INJECTED and defaults to the environment-only reader this function has
      // always used, so every existing caller behaves exactly as before. The daemon passes one that
      // ALSO reads the credential store -- which is what makes the carrier reach a real beat rather
      // than only a health field, and is the difference between diagnosing the missing key and
      // delivering it.
      const key = credential ? await credential(target) : credentialFor(target, env);
      const response = await post(url, body, key);
      const status = Number(response?.status ?? 0);
      results.push({ name, url, ok: status >= 200 && status < 300, status, error: "" });
    } catch (error) {
      results.push({ name, url, ok: false, status: 0, error: String(error?.message || error) });
    }
  }
  return results;
}
