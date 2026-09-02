// What an install still needs from the operator, decided before anything is asked or written.
//
// WHY A PLAN AND NOT PROMPTS INLINE. An installer that asks as it goes cannot say what it is about
// to do, cannot be run unattended, and cannot be tested without a terminal. Deciding first means the
// same logic answers three questions: what will be asked, what will be skipped and why, and what a
// non-interactive run should print instead of hanging on a prompt nobody can see.
//
// THE DEFECT THIS EXISTS FOR, measured 2026-09-02. A service key sat in aify-comms' `.env`, this
// host had no credential for it, and NOTHING ASKED. Every advertisement was refused with 401, the
// daemon reported healthy throughout, and the operator lost a day to a fleet that would not spawn
// with no component naming a credential. An installer that silently proceeds with a missing value is
// how that happens.
//
// ASK ONLY WHAT IS MISSING. Re-running must be safe and must be the UPDATE path -- an installer that
// re-asks for a key it already has trains an operator to paste secrets it did not need, and one that
// overwrites a working credential turns an update into an outage.

/** What the installer will do about one service. */
export const NEEDS_NOTHING = "ok";
export const WILL_ASK = "ask";
export const CANNOT_ASK = "cannot-ask";
export const NO_PLUGIN = "no-plugin";

/**
 * Decide, per registered service, whether this host still needs a credential for it.
 *
 * PURE. Everything it looks at arrives as an argument, so every branch -- including the ones that
 * only happen on a machine with no terminal -- is reachable in a test.
 *
 * @param {object} input
 * @param {Array<{name: string, endpoint: string}>} input.services  from the shared registry
 * @param {(name: string) => boolean} input.hasCredential  does this host already hold one
 * @param {(name: string) => boolean} input.hasPlugin      can this host host work for it
 * @param {boolean} input.interactive  is there a terminal to ask at
 * @returns {{steps: Array<{service: string, action: string, reason: string}>, willAsk: string[]}}
 */
export function planInstall({ services = [], hasCredential = () => false, hasPlugin = () => false, interactive = false } = {}) {
  const steps = [];
  for (const service of services) {
    const name = String(service?.name || "").trim();
    if (!name) continue;
    if (!hasPlugin(name)) {
      // NOT AN ERROR. A host may advertise to a service it cannot host work for -- describing a
      // machine and running processes for it are different offers. Saying so is what stops an
      // operator wondering later why nothing claims.
      steps.push({
        service: name,
        action: NO_PLUGIN,
        reason: "registered, but this host has no plugin to host its work",
      });
      continue;
    }
    if (hasCredential(name)) {
      steps.push({ service: name, action: NEEDS_NOTHING, reason: "a credential is already stored" });
      continue;
    }
    steps.push(
      interactive
        ? { service: name, action: WILL_ASK, reason: "no credential is stored for it" }
        : {
          service: name,
          action: CANNOT_ASK,
          // THE EXACT SYMPTOM, not "configure it". An operator who reads this and does nothing will
          // meet the 401 an hour later with no idea the two are connected.
          reason: "no credential is stored and there is no terminal to ask at. Without one, every "
            + "advertisement to this service is refused with 401 while both sides report healthy, "
            + "and no spawn can be claimed. Run this again from a terminal, or store it with "
            + "`aify-env credential set --service <name> --stdin`",
        },
    );
  }
  return { steps, willAsk: steps.filter((s) => s.action === WILL_ASK).map((s) => s.service) };
}

/** The plan in the operator's terms. PURE: returns lines, prints nothing. */
export function describePlan({ steps = [] } = {}) {
  if (!steps.length) return ["no services are registered on this host, so nothing needs a credential"];
  return steps.map((step) => {
    if (step.action === NEEDS_NOTHING) return `${step.service}: ready (${step.reason})`;
    if (step.action === WILL_ASK) return `${step.service}: will ask for a credential (${step.reason})`;
    if (step.action === NO_PLUGIN) return `${step.service}: ${step.reason}`;
    return `${step.service}: NEEDS A CREDENTIAL -- ${step.reason}`;
  });
}

/** Did the plan leave this host unable to do its job? Used for the exit status, so an unattended
 *  run FAILS rather than reporting success over a host that cannot claim anything. */
export function planIsIncomplete({ steps = [] } = {}) {
  return steps.some((step) => step.action === CANNOT_ASK);
}
