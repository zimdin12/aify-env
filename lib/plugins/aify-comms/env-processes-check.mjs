// The `env-processes` check: is every process aify-env is running one the control plane knows about?
//
// MOVED HERE FROM `aify-comms doctor` in 0.9.7 (plan D11). The comparison needs both sides: this tier's
// `/processes` and aify-comms' live terminal listing, so it lives in aify-comms' plugin and the core
// doctor names no service. What changed in the move is only where the endpoint comes from: aify-comms
// read it out of the installed launcher, and this doctor already knows which aify-env serves the host.
//
// Every collaborator is a parameter with no default, so a caller cannot accidentally reach the
// operator's own network or hostname.

import { envListing, envProcessVerdict, reconcileEnvProcesses } from "./env-process-reconciliation.mjs";

/**
 * @param deps.reads      aify-comms reads (`serviceReads`), each answering null when the service does not
 * @param deps.add        record a check result
 * @param deps.skip       record a check as not applicable here
 * @param deps.fetchJson  fetch a JSON URL outright (aify-env is not behind `get`'s base URL)
 * @param deps.machineId  this host's machine id, used to find which environment is ours
 * @param deps.endpoint   the aify-env this doctor found serving the host
 */
export async function checkEnvProcesses({ reads, add, skip, fetchJson, machineId, endpoint }) {
  if (!endpoint) {
    // NOT A PASS: with no aify-env to ask there is nothing to compare, and answering `ok` would add a
    // green row for work nobody did.
    return skip("env-processes", "no aify-env endpoint is known, so there is no environment to compare");
  }

  const listing = await fetchJson(`${endpoint}/processes`);
  // THROUGH THE SHARED READER, and the second clause is not decoration: a body that answered 200 but
  // carries no readable `processes` used to fall through to `[]` and report "nothing unaccounted
  // for". That is a green row for a listing nobody could read, which is the one thing this check
  // exists to stop.
  const { processes: envProcesses } = envListing(listing);
  if (!listing || !envProcesses) {
    return add(...toArgs("env-processes", envProcessVerdict({ envAnswered: false })));
  }

  // LIVE ONLY (`liveTerminals` asks for it explicitly). A listing that included stopped rows would
  // account for processes with terminals that ended, which is precisely the operator's case reported
  // as healthy.
  const terminals = await reads.liveTerminals();
  if (!terminals) {
    return add("env-processes", false, "unknown",
      "the service did not answer, so nothing could be compared against what aify-env is running.",
      "Check the `aify-comms` row above.");
  }

  const environments = await reads.environments();
  // WHICH ENVIRONMENT IS OURS. A doctor run probes the aify-env on ITS host, so phantoms must be
  // scoped to the environment that lives here -- otherwise every other machine's live terminals are
  // reported as missing, which is an alarm that fires on a healthy fleet.
  //
  // An id we cannot determine yields "", and the reconciliation then reports no phantoms at all
  // rather than all of them. Losing one direction is the safe way to be unsure.
  const ours = (environments?.environments ?? []).find(
    (environment) => String(environment?.machineId ?? "") === machineId,
  );

  const result = reconcileEnvProcesses({
    envProcesses,
    terminals: terminals.terminals ?? [],
    environmentId: String(ours?.id ?? ""),
  });

  return add(...toArgs("env-processes", envProcessVerdict({
    result,
    envAnswered: true,
    listingTruncated: Boolean(terminals.truncated),
  })));
}

/** A verdict as `add`'s positional arguments. Kept here so the three call sites above stay one line. */
function toArgs(id, verdict) {
  return [id, verdict.ok, verdict.code, verdict.detail, verdict.fix];
}
