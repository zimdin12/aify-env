// What the aify-dashboard plugin adds to a defined worker's env: the secrets its definition names, fetched from the
// dashboard at start, one GET each (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, B to E). Offered to the host as
// the `spawnEnv` capability, supplying the definition's `secrets` field (lib/plugins/aify-comms/spawn-env.mjs).
//
// A VALUE GOES INTO THE ANSWER AND NOWHERE ELSE: no log line, no state, no reason. A refusal is `{reason, variable}`
// in the host's list. The reason is chosen from which path failed, the HTTP status and the dashboard's code compared
// exactly, and it never carries an error's message, the dashboard's prose, its code or its status.
//
// ANY FAILURE REFUSES THE START, never the one secret (rule 5). The first one stops the fetch; the service's own start
// retry is the retry.
//
// ⛔ A COMPLETION AFTER STOP IS REFUSED, whatever the transport did with the abort. The call keeps the stop signal it
// began under, and checks it before each request, after each answer, and before it returns; a stopped call is
// unreachable whatever its error says. An answer's fields are read as own data properties, so no accessor runs. This
// is this contributor's own contract: it does not reach back into a start that already took its answer.

import { DashboardApiError } from "./dashboard-api.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** An own data property's value, or undefined: an accessor on an answer is never run. PURE. */
function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

/** The dashboard's refusals this side knows, by status and exact code, and the host reason each is. */
const KNOWN_REFUSALS = {
  404: { no_such_secret: "not-found", no_such_project: "not-found" },
  409: { unreadable: "unreadable" },
  503: { no_secret_store: "unavailable" },
};

/** The host reason for a failed fetch, from which of DashboardApi's paths it came. PURE. */
function reasonFor(error) {
  if (!(error instanceof DashboardApiError)) return "unreachable";
  if (error.kind === "no-credential") return "no-credential";
  if (error.kind !== "answered") return "unreachable";
  const known = Object.hasOwn(KNOWN_REFUSALS, error.status) ? KNOWN_REFUSALS[error.status] : {};
  return typeof error.code === "string" && Object.hasOwn(known, error.code) ? known[error.code] : "refused";
}

/**
 * The contributor.
 *
 * @param {object} deps
 * @param {string} deps.service  the plugin's name
 * @param {() => object|null} deps.api  the plugin's DashboardApi, null until it starts and after it stops
 * @param {() => AbortSignal|null} deps.stopped  the plugin's stop signal, null until it starts
 */
export function secretsContributor({ service, api, stopped }) {
  return {
    service,
    field: "secrets",
    async contribute({ definition, signal }) {
      const secrets = definition?.secrets;
      if (!secrets) return { env: {} };
      const client = api();
      const stop = stopped();
      if (!client || !stop || stop.aborted) return { refused: { reason: "unavailable" } };
      const halt = AbortSignal.any([signal, stop]);
      const env = {};
      for (const name of secrets.names) {
        if (halt.aborted) return { refused: { reason: "unreachable", variable: name } };
        let answer;
        try {
          answer = await client.secretValue(secrets.project, name, { signal: halt });
        } catch (error) {
          // A stopped call is unreachable, whatever the error says it was.
          return { refused: { reason: halt.aborted ? "unreachable" : reasonFor(error), variable: name } };
        }
        if (halt.aborted) return { refused: { reason: "unreachable", variable: name } };
        const read = isPlainObject(answer) ? { name: ownData(answer, "name"), value: ownData(answer, "value") } : null;
        if (!read || read.name !== name || typeof read.value !== "string") {
          // Reading the answer can run code, so a stop that landed during it outranks malformed.
          return { refused: { reason: halt.aborted ? "unreachable" : "bad-answer", variable: name } };
        }
        env[name] = read.value;
      }
      // AND BEFORE THE ANSWER: reading an exotic answer runs code after the last await's check.
      if (halt.aborted) return { refused: { reason: "unreachable" } };
      return { env };
    },
  };
}
