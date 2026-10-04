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
// began under, and checks it before each request and after each answer; nothing awaits between the last check and the
// answer. This is this contributor's own contract: it does not reach back into a start that already
// took its answer.

import { DashboardApiError } from "./dashboard-api.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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
          return { refused: { reason: reasonFor(error), variable: name } };
        }
        if (halt.aborted) return { refused: { reason: "unreachable", variable: name } };
        if (!isPlainObject(answer) || answer.name !== name || typeof answer.value !== "string") {
          return { refused: { reason: "bad-answer", variable: name } };
        }
        env[name] = answer.value;
      }
      // No check here: the last one ran after the last await, and nothing between it and this line awaits.
      return { env };
    },
  };
}
