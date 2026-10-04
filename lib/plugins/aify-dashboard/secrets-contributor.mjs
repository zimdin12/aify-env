// What the aify-dashboard plugin adds to a defined worker's env: the secrets its definition names, fetched from the
// dashboard at start, one GET each (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, B to E). Offered to the host as
// the `spawnEnv` capability, supplying the definition's `secrets` field (lib/plugins/aify-comms/spawn-env.mjs).
//
// A VALUE GOES INTO THE ANSWER AND NOWHERE ELSE: no log line, no state, no reason. A refusal names the secret, the
// project, and the dashboard's status and code, never the dashboard's prose, which this side does not control.
//
// ANY FAILURE REFUSES THE START, never the one secret (rule 5). The first one stops the fetch; the service's own start
// retry is the retry.

import { DashboardApiError } from "./dashboard-api.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Why a fetch failed, from what the dashboard answered, or what stopped it answering. PURE. */
function failure(asked, error) {
  if (error instanceof DashboardApiError && error.status) {
    return `${asked} was refused: ${error.status}${error.code ? ` ${error.code}` : ", with no code"}`;
  }
  return `${asked} could not be fetched: ${error?.message || error}`;
}

/**
 * The contributor.
 *
 * @param {object} deps
 * @param {string} deps.service  the plugin's name, which the host puts before any refusal
 * @param {() => object|null} deps.api  the plugin's DashboardApi, null until it starts
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
      if (!client) return { refused: `the ${service} plugin has not started` };
      const halt = AbortSignal.any([signal, stopped()].filter(Boolean));
      const env = {};
      for (const name of secrets.names) {
        const asked = `secret ${name} for project ${secrets.project}`;
        let answer;
        try {
          answer = await client.secretValue(secrets.project, name, { signal: halt });
        } catch (error) {
          return { refused: failure(asked, error) };
        }
        if (!isPlainObject(answer) || answer.name !== name || typeof answer.value !== "string") {
          return { refused: `${asked}: the answer was not that secret's value` };
        }
        env[name] = answer.value;
      }
      return { env };
    },
  };
}
