// The two calls this plugin makes to aify-dashboard. The only file in aify-env that names one of its
// routes.
//
// THE CREDENTIAL IS FETCHED PER CALL, for the reason the comms plugin gives: a key rotated while this
// host runs must reach the next request, not the next restart. It is sent to this entry's endpoint and
// nowhere else.

/** How long one request may take before it is abandoned and the pass moves on. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** A refused or failed call, carrying what the dashboard said so a doctor row can repeat it. */
export class DashboardApiError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
  }
}

export class DashboardApi {
  #endpoint;
  #credential;
  #fetch;

  /**
   * @param {object} deps
   * @param {string} deps.endpoint  the service root from the registry entry
   * @param {() => Promise<string>} deps.credential  resolved per call, never cached here
   * @param {typeof fetch} [deps.fetch]
   */
  constructor({ endpoint, credential, fetch: fetchImpl = globalThis.fetch }) {
    this.#endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.#credential = credential;
    this.#fetch = fetchImpl;
  }

  /** The folders the dashboard lists for this host: its answer, unparsed. */
  async watchList(hostKey) {
    return this.#call("GET", `/api/v1/host/${encodeURIComponent(hostKey)}/watch-list`);
  }

  /**
   * Where one folder's HEAD is.
   *
   * `bridgeInstanceId` is the dashboard's name for the reporter: it refuses a second, different
   * reporter for one folder inside a minute with a 409, which is how two daemons on one host are noticed.
   */
  async reportHead({ machineId, path, head, reporter }) {
    return this.#call("POST", "/reports/head", {
      machineId, worktree: { raw: path, canonical: path }, head, bridgeInstanceId: reporter,
    });
  }

  async #call(method, path, body) {
    const key = String((await this.#credential()) || "");
    if (!key) throw new DashboardApiError("no credential for aify-dashboard on this host");
    let response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method,
        headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DashboardApiError(`aify-dashboard did not answer ${method} ${path}: ${error?.message || error}`);
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const said = parsed?.error ? `: ${parsed.error}` : "";
      throw new DashboardApiError(`aify-dashboard answered ${method} ${path} with ${response.status}${said}`,
        { status: response.status, code: String(parsed?.code || "") });
    }
    return parsed;
  }
}
