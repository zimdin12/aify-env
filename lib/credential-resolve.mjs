/**
 * The key this daemon will present to one service, from the environment or the store, with a typed
 * answer either way.
 *
 * THIS IS THE PIECE THAT MAKES THE CARRIER DO ANYTHING. Until now the credential came only from this
 * daemon's process environment, and nothing on the host puts it there -- the aify-comms bridge does
 * not start this daemon. So enabling `API_KEY` on that service made every advertisement 401,
 * `advertising` stayed false, the bridge correctly kept describing the host, and every part of that
 * chain was behaving correctly while the operator saw a daemon that runs and is never believed.
 *
 * PRECEDENCE IS THE INSTALLER'S, DELIBERATELY. `keyEnv` stays a manual-launch override, because an
 * operator who exports a key is making a choice a file must not silently overrule. Two DIFFERENT
 * non-empty values is not a preference question: it is the shape where clients hold one key and the
 * service runs on another, so it is a typed CONFLICT and NEITHER is used. `scripts/api-key.sh` in
 * aify-comms rules the same way on the same question, which is not a coincidence -- it is the same
 * question.
 *
 * READ ON EVERY BEAT, AND THERE IS NO CACHE. There was one, and the reviewer showed it was pure
 * downside: it called the reader FIRST -- which already reads every byte -- and only then compared a
 * device/inode/size/mtime tuple to decide whether to return the PREVIOUS object instead of the fresh
 * one it had just fetched. So it saved no work at all and added a way to serve a stale key, because
 * that tuple is metadata rather than content: an inode can be zero or reused, and a same-size atomic
 * replacement can share an mtime tick. Keying it on a hash of the bytes would be no cheaper, since
 * the bytes are already in hand by then. The file is small and local; reading it is the cheap part.
 */

import {
  CREDENTIAL_ABSENT,
  CREDENTIAL_INVALID,
  CREDENTIAL_OK,
  credentialValueProblem,
  resolveCredential,
} from "./credential-store.mjs";
import { readCredentialFile } from "./credential-fs.mjs";

/**
 * Read one target's credential.
 *
 * @returns {{state: string, value: string, source: string, detail: string, ref: string}}
 *   `state` is CREDENTIAL_OK, CREDENTIAL_ABSENT, or one of the faults. A fault NEVER carries a
 *   value, and absence is not a fault: a service that needs no key is a valid deployment.
 */
export async function credentialForTarget(target, {
  env = process.env, root, ...options
} = {}) {
  const keyEnv = Array.isArray(target?.keyEnv) ? target.keyEnv : [];
  // TAKEN EXACTLY, AND VALIDATED -- not trimmed. A `.trim()` here would silently turn a key that
  // picked up a stray space into a DIFFERENT key from the one the service was configured with, and
  // the resulting 401 would have no visible cause on either side. The store already refuses those
  // bytes on the way in; the environment path has to hold the same line or the two disagree about
  // what the effective key even is.
  let envValue = "";
  let envProblem = "";
  for (const name of keyEnv) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw) === "") continue;
    const value = String(raw);
    const problem = credentialValueProblem(value);
    if (problem) { envProblem = `${name} ${problem}`; break; }
    envValue = value;
    break;
  }
  if (envProblem) {
    return {
      state: CREDENTIAL_INVALID, value: "", source: "", ref: String(target?.credentialRef || ""),
      detail: `the credential in the environment is unusable: ${envProblem}`,
    };
  }

  const ref = String(target?.credentialRef || "");
  if (!ref) {
    // NO REFERENCE IS NOT A FAULT. A service that never stored a credential here is either keyless
    // or driven entirely from the environment, and both are configurations rather than problems.
    const answer = resolveCredential({ envValue, fileValue: "" });
    return { ...answer, ref: "" };
  }

  const fromFile = await readCredentialFile({ root, ref, ...options });
  if (fromFile.state !== CREDENTIAL_OK) {
    // A FAULT WINS OVER AN ENVIRONMENT KEY, and that is deliberate. The registry says this service
    // has a stored credential; if it cannot be read, or its permissions are wrong, the operator has
    // a broken store and needs to hear so. Quietly falling back to an environment value would hide
    // exactly the condition the typed states exist to surface -- and on a host where the two differ,
    // it would also mean presenting a key nobody expected.
    return { state: fromFile.state, value: "", source: "", detail: fromFile.detail, ref };
  }

  const answer = resolveCredential({ envValue, fileValue: fromFile.value });
  return { ...answer, ref };
}

/**
 * Whether this daemon holds a usable credential for each target, and why not when it does not.
 *
 * NAMES, STATES AND A BOOLEAN -- never a value, a length, a prefix or a hash. `/health` is
 * unauthenticated, and each of those narrows a search that the boolean does not.
 */
export async function credentialReadinessFor(targets, options = {}) {
  const out = {};
  for (const target of Array.isArray(targets) ? targets : []) {
    const url = String(target?.url || "");
    if (!url) continue;
    const answer = await credentialForTarget(target, options);
    out[String(target?.name || url)] = {
      keyEnv: Array.isArray(target?.keyEnv) ? target.keyEnv.slice() : [],
      credentialRef: answer.ref,
      hasCredential: answer.state === CREDENTIAL_OK,
      state: answer.state,
      // The detail explains a FAULT. On the happy path and on a plain absence it is empty, so a
      // reader cannot mistake an explanation for a problem.
      detail: answer.state === CREDENTIAL_OK || answer.state === CREDENTIAL_ABSENT
        ? ""
        : answer.detail,
      source: answer.source || "",
    };
  }
  return out;
}
