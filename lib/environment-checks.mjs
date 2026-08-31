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
 * Does this daemon hold the credential its advertisements need?
 *
 * THE FAILURE THIS MAKES VISIBLE. The credential comes from this daemon's own process environment,
 * under the names the registry declares. Nothing on the host puts it there: the aify-comms bridge
 * does not start this daemon -- its own doctor says "Start aify-env on this host" -- so a key is
 * present only if whoever launched it exported one. Set `API_KEY` on that service and every
 * advertisement is refused, `advertising` stays false, and the bridge correctly keeps describing the
 * host. That chain is SAFE and completely silent: the daemon runs, answers `/health`, and is simply
 * never believed, three components away from anything that looks wrong.
 *
 * SCOPED TO TARGETS THAT ARE BOTH SILENT AND KEYLESS, which is what keeps it from crying wolf. A
 * daemon with no credential against a service that requires none is a correct configuration -- it is
 * this host today -- and there the beats are ACCEPTED, so the target is fresh and never reported.
 * The pairing is the finding: nobody is accepting us, and we have nothing to present.
 *
 * ADVERTISING OFF IS NOT A FAULT. `AIFY_ADVERTISE=0` hands the job back to the bridge deliberately,
 * and every target is silent by design. Reporting a missing key then would fail a host that is
 * configured exactly as intended.
 *
 * NO EVIDENCE IS NOT A PASS. If the daemon did not answer, this says so rather than reporting a tidy
 * zero: "no credential configured" and "nobody asked" are different answers, and only one is a fact.
 */
export function advertiseCredentialCheck({
  answered = false, enabled = null, credentials = null, services = null,
} = {}) {
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

  const accepting = (name) => services?.[name]?.fresh === true;
  const silentAndKeyless = names.filter(
    (name) => credentials[name]?.hasCredential !== true && !accepting(name),
  );

  if (silentAndKeyless.length === 0) {
    const held = names.filter((name) => credentials[name]?.hasCredential === true).length;
    return passed(
      "advertise-cred",
      held === names.length
        ? `a credential is configured for all ${names.length} target(s)`
        : `every target is accepting beats or holds a credential (${held}/${names.length} keyed)`,
    );
  }

  const detail = silentAndKeyless
    .map((name) => {
      const declared = credentials[name]?.keyEnv ?? [];
      return declared.length > 0
        ? `${name} (set one of ${declared.join(" or ")})`
        : `${name} (its registry entry declares no key variable, so none can be supplied)`;
    })
    .join("; ");

  return failed(
    "advertise-cred",
    `not advertising to, and holding no credential for: ${detail}`,
    "Export the variable in the environment that STARTS aify-env, not in a shell that merely talks "
      + "to it. If that service is simply down, fix that first -- this row cannot tell the two "
      + "apart, and says only that we are not being heard and have nothing to present.",
  );
}
