// The calls this plugin makes to aify-dashboard. The only file in aify-env that names one of its routes.
//
// TWO KEYS, EACH TO ONE PLACE. The API key goes to the watch list and head reports. The secrets fetch key goes, as
// `x-aify-secrets-key`, only to the route that hands out a secret's value, and that route is never sent the API key.
//
// THE CREDENTIAL IS FETCHED PER CALL, for the reason the comms plugin gives: a key rotated while this
// host runs must reach the next request, not the next restart. It is sent to this entry's endpoint and
// nowhere else, which is why a redirect is never followed: a fetch that followed one would carry the key
// to wherever the 3xx pointed. A redirect is answered as a refusal.
//
// EVERY CALL TAKES THE PLUGIN'S STOP SIGNAL, so stopping the plugin cancels a request in flight rather than
// waiting out its timeout.

/** How long one request may take before it is abandoned and the pass moves on. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A refused or failed call, carrying what the dashboard said so a doctor row can repeat it.
 *
 * `kind` is which of this client's own paths it came from, never anything the answer said: `no-credential` (no key
 * to present), `unanswered` (the request or the reading of its body failed), or `answered` (any HTTP answer). `code`
 * is the answer's `code` only when that is a string, so an array or a number is never turned into a known code.
 */
export class DashboardApiError extends Error {
  constructor(message, { status = 0, code = "", kind = "unanswered" } = {}) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

export class DashboardApi {
  #endpoint;
  #apiKey;
  #fetchKey;
  #fetch;

  /**
   * @param {object} deps
   * @param {string} deps.endpoint  the service root from the registry entry
   * @param {() => Promise<string>} deps.credential  resolved per call, never cached here
   * @param {() => Promise<string>} [deps.secretsCredential]  the secrets fetch key, resolved per call too
   * @param {typeof fetch} [deps.fetch]
   */
  constructor({ endpoint, credential, secretsCredential = async () => "", fetch: fetchImpl = globalThis.fetch }) {
    this.#endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.#apiKey = { header: "x-api-key", credential, absent: "no credential for aify-dashboard on this host" };
    this.#fetchKey = { header: "x-aify-secrets-key", credential: secretsCredential,
      absent: "no secretsCredentialRef for aify-dashboard on this host" };
    this.#fetch = fetchImpl;
  }

  /** The folders the dashboard lists for this host: its answer, unparsed. */
  async watchList(hostKey, { signal } = {}) {
    return this.#call("GET", `/api/v1/host/${encodeURIComponent(hostKey)}/watch-list`, undefined, signal);
  }

  /**
   * Where one folder's HEAD is.
   *
   * `bridgeInstanceId` is the dashboard's name for the reporter: it refuses a second, different
   * reporter for one folder inside a minute with a 409, which is how two daemons on one host are noticed.
   */
  async reportHead({ machineId, path, head, reporter }, { signal } = {}) {
    return this.#call("POST", "/reports/head", {
      machineId, worktree: { raw: path, canonical: path }, head, bridgeInstanceId: reporter,
    }, signal);
  }

  /** One secret's value, for a worker's env: the dashboard's `{name, value}`, unparsed. Presents the fetch key alone. */
  async secretValue(projectId, name, { signal } = {}) {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}/value`;
    return this.#call("GET", path, undefined, signal, this.#fetchKey);
  }

  async #call(method, path, body, stop, presenting = this.#apiKey) {
    const key = String((await presenting.credential()) || "");
    // A stop while the credential was pending sends nothing: the key would go out under an aborted signal.
    if (stop?.aborted) throw new DashboardApiError(`${method} ${path} was stopped before it was sent`);
    if (!key) throw new DashboardApiError(presenting.absent, { kind: "no-credential" });
    let response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method,
        headers: { [presenting.header]: key, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: stop ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), stop]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DashboardApiError(`aify-dashboard did not answer ${method} ${path}: ${error?.message || error}`);
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new DashboardApiError(`aify-dashboard's answer to ${method} ${path} could not be read: ${error?.message || error}`);
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const said = parsed?.error ? `: ${parsed.error}` : "";
      throw new DashboardApiError(`aify-dashboard answered ${method} ${path} with ${response.status}${said}`,
        { status: response.status, code: typeof parsed?.code === "string" ? parsed.code : "", kind: "answered" });
    }
    return parsed;
  }
}
