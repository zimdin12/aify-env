// What aify-env can say about itself.
//
// Each component answers only questions about itself; nothing here reaches into another one. The
// distinctions below all come down to the same discipline: a state must say what KIND of not-fine
// something is, because the remedies differ and a reader who is given the wrong kind goes looking in
// the wrong place.
//
//   absent     -> passed      a host with no services registered is a legitimate host
//   corrupt    -> failed      we read it and it is wrong
//   unreadable -> unanswered  we never saw it; that is a permissions problem, not a content problem

import { credentialOrphans } from "./credential-store.mjs";
import { failed, passed, unanswered } from "./health.mjs";
import { readServices, registryVersion, SUPPORTED_REGISTRY_VERSION } from "./services.mjs";

/**
 * Can this host give a process a real terminal?
 *
 * Unavailable is a FAILURE rather than a shrug. We know the answer and it is no, and the consequence is
 * concrete: without a PTY a console cannot render a TUI, so terminal-backed runtimes lose the thing
 * that makes them watchable. Reporting a known capability loss as "could not tell" is how it gets
 * ignored until somebody opens a console and finds it empty.
 */
export function terminalCheck(support) {
  if (support?.available) {
    // NAMES ITS SUBJECT. This is node-pty loading in THIS process, which is not the same claim as
    // "agents will get a TUI": the environment that spawns them answers for itself on /health, and it
    // need not be the same install. The two were seen disagreeing on one host, and a reader had no way
    // to know they were answering different questions.
    return passed("terminal", "this process can open a real terminal (the environment reports its own)");
  }
  return failed(
    "terminal",
    `no terminal support: ${support?.reason ?? "unknown"}`,
    "Install node-pty in this environment. Until then processes run with piped stdio and a console "
    + "cannot render a TUI for them.",
  );
}

/**
 * Can aify-env tell which services are registered?
 *
 * @param {{text?: string|null, missing?: boolean, readError?: string}} source
 */
export function registryCheck(source) {
  if (source?.readError) {
    return unanswered("registry", `could not read the service registry: ${source.readError}`);
  }
  if (source?.missing || source?.text == null || String(source.text).trim() === "") {
    return passed("registry", "no services are registered on this host yet");
  }

  // A registry NEWER than this build is not a broken one, and must not be reported as though it were.
  // Reading a format we do not know with the assumptions of one we do is a guess, and the answer it
  // produces looks exactly like a real one.
  const declared = registryVersion(source.text);
  if (declared !== null && declared !== SUPPORTED_REGISTRY_VERSION) {
    return unanswered(
      "registry",
      `the service registry declares version ${declared}; this aify-env understands `
      + `${SUPPORTED_REGISTRY_VERSION}, so what is registered cannot be read. Upgrade aify-env.`,
    );
  }

  const services = readServices(source.text);
  if (services.length === 0) {
    // readServices is deliberately tolerant, so zero from non-empty text means it did not parse.
    //
    // REPAIR, NEVER REMOVE. This file is shared: it holds every service's entry, and the services whose
    // entries vanish are not the one being diagnosed. aify-comms' own writer refuses to rewrite an
    // unreadable registry for that exact reason, so advising a delete here would have told the operator
    // to do by hand what the writer declines to do for them.
    return failed(
      "registry",
      "the service registry is present but unreadable, so no service can be located",
      "Repair ~/.aify/services.json — it holds every service's entry, so replacing it uninstalls the "
      + "others. Re-run each service's installer to rebuild entries you lose.",
    );
  }
  return passed("registry", `${services.length} service(s) registered: ${services.map((s) => s.name).join(", ")}`);
}

/**
 * Does aify-env still know what it owns?
 *
 * Unknown entries make this UNANSWERED. The reaper keeps what it cannot judge rather than reaping it,
 * which is the right call — dropping a live process out of the only place that knows about it is worse
 * than the leak. But that decision has to surface somewhere, or it quietly becomes a leak nobody sees.
 */
export function ownedProcessesCheck({ owned = [], unknown = [] } = {}) {
  if (unknown.length > 0) {
    const ids = unknown.map((entry) => `${entry.id}(pid ${entry.pid})`).join(", ");
    return unanswered(
      "processes",
      `${owned.length} owned, ${unknown.length} whose liveness could not be determined: ${ids}`,
    );
  }
  return passed("processes", `${owned.length} process(es) owned by this environment`);
}

/** An object, and not an array or null. Both of those pass a naive typeof check. */
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Is this answer from an aify-env, or merely from something that answered?
 *
 * THE DISTINCTION IS THE WHOLE POINT. `knock` reports ok for any response it could parse, including a
 * 404 and a 500, so "somebody is listening" was being read as "an environment is running". On the host
 * where this was found, a FastAPI service on the environment's port answered /health with a bare
 * `{"status":"healthy"}` and the doctor called it an environment. The next row then reported zero owned
 * processes, which is exactly what a healthy idle environment looks like.
 *
 * Identified by SHAPE rather than by a status string, because `status: "healthy"` is the most common
 * health body in existence and says nothing about who sent it. An aify-env reports what it OWNS: a
 * processes array and a terminals object. Nothing else on a host has reason to.
 *
 * @param {{ok?: boolean, status?: number, body?: unknown}} answer
 * @returns {boolean}
 */
/**
 * What a takeover would destroy, given the incumbent's own account of what it is running.
 *
 * SUPERSESSION IS FATAL TO THE INCUMBENT'S WORK, and on this platform it cannot be made otherwise.
 * Starting aify-env stops whatever holds the port and its processes die with it -- measured twice on
 * 2026-09-01, five agents each time, three of them mid-work. Adoption was built and does not work:
 * a child spawned with `detached: false` dies when its parent is killed, and node-pty offers no way
 * to detach, so a PTY-backed agent is bound to a ConPTY the daemon owns. Agents run on the PTY path
 * because a visible TUI is a hard requirement, which makes the case that matters the one that cannot
 * be rescued.
 *
 * So the remedy is not to make the kill survivable. It is to STOP DOING IT BY ACCIDENT. The operator's
 * words were "i had to start because i needed to see what is going on" -- observing the fleet required
 * the one action that destroys it, and nothing said so beforehand.
 *
 * The incumbent already publishes the answer: `/health` lists what it owns. Asking costs one request
 * that has already been made.
 *
 * RETURNS WHAT WOULD DIE, never a verdict. The caller decides what to do about it, and a list is the
 * only shape that lets it say WHICH agents rather than how many. Empty means nothing is in the way,
 * which is the ordinary case and must stay silent.
 *
 * @param {unknown} processes the incumbent's `processes` array, as it reported it
 * @param {{force?: boolean}} [options] `force` is the operator saying they meant it
 * @returns {object[]} the entries a takeover would end, empty when there is nothing to lose
 */
export function workLostToSupersession(processes, { force = false } = {}) {
  if (force) return [];
  // A malformed or absent list is NOT evidence that nothing is running. But refusing on it would make
  // an unreachable incumbent unkillable, and the caller has already established this IS an aify-env by
  // shape -- which required the array. So an unusable list means the shape check would have failed
  // first, and treating it as empty here cannot strand anything the caller did not already accept.
  if (!Array.isArray(processes)) return [];
  return processes.filter((entry) => entry && typeof entry === "object");
}

export function looksLikeEnvironment(answer) {
  if (!answer?.ok) return false;
  const status = Number(answer.status ?? 0);
  if (status < 200 || status >= 300) return false;
  const body = answer.body;
  if (!isPlainObject(body)) return false;
  return Array.isArray(body.processes) && isPlainObject(body.terminals);
}

/**
 * Is an environment running where we were told to look?
 *
 * FAILED rather than unanswered in both negative cases, and deliberately: we CAN tell. Nothing
 * listening is a fact, and something-else listening is a fact. Neither is missing evidence.
 *
 * The two failures need different remedies, which is why they are not one message. "Start one" is
 * useless advice when the port is already taken by something else.
 *
 * @param {string} endpoint
 * @param {{ok?: boolean, status?: number, body?: unknown, error?: string}} answer
 */
export function environmentCheck(endpoint, answer) {
  if (!answer?.ok) {
    return failed(
      "environment",
      `no environment is running at ${endpoint}: ${answer?.error ?? "no answer"}`,
      "Start one with: aify-env",
    );
  }
  if (!looksLikeEnvironment(answer)) {
    return failed(
      "environment",
      `something is listening at ${endpoint}, but it is not an aify-env: its /health does not report `
      + "the processes and terminals an environment owns",
      `Free ${endpoint} or point AIFY_ENV_ENDPOINT at the real environment. Managed spawns cannot run `
      + "against whatever is there now.",
    );
  }
  return passed("environment", `an environment is running at ${endpoint}`);
}

/**
 * Why is this daemon not being heard by one service?
 *
 * ONE ATTEMPT, CLASSIFIED. The first version of this check keyed on "silent AND keyless" and called
 * that a credential fault, which conflated a service that REFUSED us with one that was DOWN. They
 * have different owners: the first is a key to set on this host, the second is somebody else's
 * outage, and a doctor row that blames the wrong one sends the operator to the wrong machine.
 *
 * The evidence to separate them was already being thrown away. `advertiseTo` has always returned
 * `{ok, status, error}` per target and it was only ever printed to stderr. A `status` of 0 with a
 * transport error is a connection that never got an answer; a real HTTP status is an answer we did
 * not like. 401 and 403 are that answer saying our credential is wrong or missing.
 */
export function advertiseAttemptCause(attempt) {
  if (attempt === null || attempt === undefined) return "never-attempted";
  if (attempt.ok === true) return "accepted";
  const status = Number(attempt.status || 0);
  if (status === 401 || status === 403) return "refused-credential";
  if (status === 0) return "unreachable";
  return "refused-other";
}

/**
 * Does this daemon hold the credential its advertisements need, and is that why it is unheard?
 *
 * THE FAILURE THIS MAKES VISIBLE. The credential comes from this daemon's own process environment,
 * under the names the registry declares. Nothing on the host puts it there: the aify-comms bridge
 * does not start this daemon -- its own doctor says "Start aify-env on this host" -- so a key is
 * present only if whoever launched it exported one. Set `API_KEY` on that service and every
 * advertisement is refused, `advertising` stays false, and the bridge correctly keeps describing the
 * host. That chain is SAFE and completely silent: the daemon runs, answers `/health`, and is never
 * believed, three components away from anything that looks wrong.
 *
 * IT ONLY BLAMES THE CREDENTIAL WHEN THE SERVICE SAID SO. A 401 or 403 is the service telling us our
 * key is wrong or absent, and that is a fault on this host. Anything else -- unreachable, a 500, a
 * beat not yet attempted -- is `unanswered`: real evidence that we are not being heard, and no
 * evidence about why. Reporting those as a missing key would be a guess wearing a verdict's clothes.
 *
 * ADVERTISING OFF IS NOT A FAULT. `AIFY_ADVERTISE=0` hands the job back to the bridge deliberately,
 * and every target is silent by design.
 */
export function advertiseCredentialCheck({
  answered = false, enabled = null, credentials = null, attempts = null,
} = {}) {
  // THE SAME OVERLOADED NULL as `claimingCheck` below, and this row is where it was found: it read
  // "no aify-env answered" directly under a row saying one was running at 127.0.0.1:8802. A daemon
  // that ANSWERED but predates this field is a different situation from nothing listening, and it
  // has a different remedy -- restart it, rather than start one.
  if (answered && (credentials === null || typeof credentials !== "object")) {
    return unanswered(
      "advertise-cred",
      "this aify-env is running but does not report its advertisement credentials, so whether it "
      + "holds one is unknown — restart it on a build that does",
    );
  }
  if (!answered || credentials === null || typeof credentials !== "object") {
    return unanswered(
      "advertise-cred",
      "no aify-env answered, so whether it holds an advertisement credential is unknown",
    );
  }

  const names = Object.keys(credentials);
  if (names.length === 0) {
    return passed("advertise-cred", "no advertisement targets, so no credential is needed");
  }
  if (enabled === false) {
    return passed(
      "advertise-cred",
      `advertising is off, so none of the ${names.length} target(s) needs a credential`,
    );
  }

  const causeFor = (name) => advertiseAttemptCause(attempts?.[name] ?? null);
  const describe = (name) => {
    const declared = credentials[name]?.keyEnv ?? [];
    if (credentials[name]?.hasCredential === true) {
      return `${name} (a credential IS set and was refused -- it is the wrong value, not a missing one)`;
    }
    return declared.length > 0
      ? `${name} (no credential; set one of ${declared.join(" or ")})`
      : `${name} (no credential, and its registry entry declares no key variable, so none can be supplied)`;
  };

  const refused = names.filter((name) => causeFor(name) === "refused-credential");
  if (refused.length > 0) {
    return failed(
      "advertise-cred",
      `refused on credentials by: ${refused.map(describe).join("; ")}`,
      "Export the variable in the environment that STARTS aify-env, not in a shell that merely "
        + "talks to it. A daemon already running will not pick it up.",
    );
  }

  const unheard = names.filter((name) => causeFor(name) !== "accepted");
  if (unheard.length === 0) {
    const held = names.filter((name) => credentials[name]?.hasCredential === true).length;
    return passed(
      "advertise-cred",
      `every target is accepting beats (${held}/${names.length} with a credential configured)`,
    );
  }

  // EVIDENCE THAT WE ARE UNHEARD, AND NONE ABOUT WHY. Naming the cause we observed keeps this from
  // reading as "no problem found" while a service is down.
  const detail = unheard
    .map((name) => {
      const cause = causeFor(name);
      const status = Number(attempts?.[name]?.status || 0);
      if (cause === "never-attempted") return `${name} (no beat attempted yet)`;
      if (cause === "unreachable") return `${name} (no answer: ${attempts?.[name]?.error || "unreachable"})`;
      return `${name} (answered ${status}, which is not a credential refusal)`;
    })
    .join("; ");
  return unanswered(
    "advertise-cred",
    `not being heard by ${unheard.length} of ${names.length} target(s), and not on credentials: ${detail}`,
  );
}

/**
 * What is in the credential store that nothing references, and what is referenced but absent.
 *
 * REPORTS, NEVER DELETES. A file nobody references today may be referenced by a registry that is
 * currently unreadable, and deleting a population on that reasoning is how a cleanup becomes an
 * outage. The custody ruling is explicit: an orphan is a doctor finding, and a purge is an explicit
 * act against an exact reference.
 *
 * A STORE THAT COULD NOT BE LISTED IS `unanswered`, not clean. That distinction is the whole reason
 * `listCredentialStore` returns a typed problem instead of an empty array: a check that reports "no
 * orphans" because it could not look is worse than one that says nothing, since it closes the
 * question.
 *
 * DANGLING IS THE URGENT HALF. An orphan is a secret nobody presents; a dangling reference is a
 * service that will fail to advertise until somebody fixes it, and it fails with a typed
 * CREDENTIAL_MISSING rather than silently -- but only once something tries.
 */
export function credentialStoreCheck({
  storeProblem = "", storeNames = null, registryRefs = null,
} = {}) {
  if (storeProblem) {
    return unanswered("credentials", `the credential store could not be read: ${storeProblem}`);
  }
  if (storeNames === null || registryRefs === null) {
    return unanswered("credentials", "the credential store or the registry was not readable");
  }

  const { orphans, dangling } = credentialOrphans({ storeNames, registryRefs });

  if (dangling.length) {
    return failed(
      "credentials",
      `${dangling.length} registry reference(s) name a credential that is not stored: `
        + `${dangling.join(", ")}`,
      "Re-run the service's installer with its API key so the credential is stored again, or clear "
        + "the reference. Until then that service cannot present a key and its advertisements will "
        + "be refused.",
    );
  }
  if (orphans.length) {
    return failed(
      "credentials",
      `${orphans.length} stored credential(s) that no registry entry references: ${orphans.join(", ")}`,
      "These are secrets nothing will present. Remove one with "
        + "`aify-env credential remove --service <name>` after checking which service it belonged "
        + "to -- they are reported rather than deleted, because a registry that is briefly "
        + "unreadable would otherwise look like permission to delete everything.",
    );
  }
  return passed(
    "credentials",
    storeNames.length === 0
      ? "no credentials stored"
      : `${storeNames.length} stored credential(s), each referenced by the registry`,
  );
}

/**
 * Is this host actually CLAIMING work for the services it serves?
 *
 * THE QUESTION NOTHING ANSWERED, and the reason a day was lost on 2026-09-02. `advertising` says
 * this daemon DESCRIBES the machine; claiming is a separate capability, deliberately, so that a host
 * with no claimer stops reading as ready. For hours the advertiser was healthy, the aify-comms
 * plugin's every heartbeat was discarded by supersession arbitration while answering `ok: true`,
 * `/spawn` refused six times, and every instrument reported the half that worked. The operator ran
 * exactly what they were told to and was refused; two agents read the same signals and told them the
 * fleet was ready.
 *
 * FOUR STATES, and collapsing any pair puts the reader in the wrong place:
 *   - no plugin started      -> nothing here claims anything. FAILED: the spawn path is dead.
 *   - accepted               -> passed, and it names the service.
 *   - refused                -> FAILED, and it names who holds the row. Restarting this daemon does
 *                               not help if another claimer legitimately owns it.
 *   - not yet / cannot say   -> UNANSWERED. A plugin that has not beaten, or a service too old to
 *                               answer, has produced no evidence -- and this project's two worst
 *                               false greens were both checks that reported no evidence as a pass.
 *
 * PURE: it is handed what `/health` said and returns a check. The doctor runs in a different process
 * from the daemon, so anything it worked out for itself would be answering a question nobody asked.
 */
export function claimingCheck({ answered = false, plugins = null } = {}) {
  // TWO REASONS TO HAVE NO ANSWER, and they send the reader to different places: nothing is running,
  // or something is running and is too old to say. Both arrive here as `null`, and collapsing them
  // is not hypothetical -- it printed "no aify-env answered" one line under a row reporting an
  // environment running at 127.0.0.1:8802, in this doctor's own output, while diagnosing this very
  // problem. Two rows of one report contradicting each other is worse than either row alone.
  if (!answered) {
    return unanswered("claiming", "no aify-env answered, so what it claims for is unknown");
  }
  if (!Array.isArray(plugins)) {
    // Running, and too old to report plugins. NOT a failure: it may be claiming perfectly well and
    // simply cannot say, and calling that broken would fire on every host mid-upgrade.
    return unanswered(
      "claiming",
      "this aify-env is running but does not report its plugins, so whether it claims is unknown"
      + " — restart it on a build that does",
    );
  }
  if (plugins.length === 0) {
    return failed(
      "claiming",
      "no service plugin is running, so nothing here claims work — spawns for this host will be refused",
      "check the boot output for 'registered but no plugin to host their work', and that "
      + "~/.aify/services.json lists the service",
    );
  }

  const refused = [];
  const accepted = [];
  const silent = [];
  for (const entry of plugins) {
    const name = String(entry?.name || "(unnamed)");
    const claimer = entry?.state?.claimer;
    if (claimer && claimer.accepted === true) accepted.push(name);
    else if (claimer && claimer.accepted === false) {
      refused.push(`${name} (held by ${claimer.bridgeId || "unknown"}: ${claimer.reason || "no reason given"})`);
    } else silent.push(name);
  }

  if (refused.length) {
    return failed(
      "claiming",
      `refused as the claimer for: ${refused.join("; ")}`,
      "another claimer holds that environment. Stop it, or check that this host's heartbeat carries "
      + "metadata.bridgeStartedAt — a beat without it loses every arbitration and is answered ok",
    );
  }
  if (accepted.length) {
    const trailing = silent.length ? `; not yet answered for: ${silent.join(", ")}` : "";
    return passed("claiming", `claiming work for: ${accepted.join(", ")}${trailing}`);
  }
  return unanswered(
    "claiming",
    `${silent.join(", ")} started but has not been told whether it is the claimer yet`,
  );
}


/**
 * When a takeover is refused, should the view be OPENED rather than described?
 *
 * A4, the operator 2026-08-24: "bare `aify-env` opens the tui". Their reason for starting a second
 * environment was *"i had to start because i needed to see what is going on"*, so a refusal that
 * names a second command to type is one step short of the answer.
 *
 * A PREDICATE RATHER THAN AN `if` IN THE ENTRY SCRIPT, because the true branch cannot be reached by
 * a test: proving it needs a real TTY, and a spawned child has a pipe. Left inline, the only tested
 * arm would be the one that changes nothing -- which is how this repo's doctor predicates came to
 * live in a module, and the first thing that move caught was a real bug.
 *
 * BOTH INPUTS MUST BE TRUE-ISH IN THE RIGHT DIRECTION and neither defaults to yes. A view belongs in
 * a terminal and nowhere else: escapes in a log are noise, a service manager parses this output, and
 * anything reading the exit status must keep reading the same one. `AIFY_NO_DASHBOARD` already means
 * "no view" for the daemon's own banner and has to mean the same thing here, or an operator who
 * turned it off gets one at the least welcome moment.
 *
 * @param {{isTty?: unknown, noDashboard?: unknown}} where
 */
export function showViewInsteadOfRefusing({ isTty = false, noDashboard = "" } = {}) {
  if (isTty !== true) return false;
  return String(noDashboard ?? "").trim() !== "1";
}
