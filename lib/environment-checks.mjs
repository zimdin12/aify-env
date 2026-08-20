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
    return passed("terminal", "a real terminal is available for processes that need one");
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
