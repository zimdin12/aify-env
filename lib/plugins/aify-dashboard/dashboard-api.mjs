// Every call this plugin makes to aify-dashboard. The only file in aify-env that names one of its
// routes.
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

/** A refused or failed call, carrying what the dashboard said so a doctor row can repeat it. */
export class DashboardApiError extends Error {
  constructor(message, { status = 0, code = "", current = null } = {}) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
    // What the dashboard says the state really is, when it refuses a range or a resync as stale: the reporter
    // corrects itself from this rather than guessing.
    this.current = current;
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
  async watchList(hostKey, { signal } = {}) {
    return this.#call("GET", `/api/v1/host/${encodeURIComponent(hostKey)}/watch-list`, undefined, signal);
  }

  /** Which of this host's projects have code-provider calls a claim would hand out now: its answer, unparsed. */
  async providerPending(hostKey, { signal } = {}) {
    return this.#call("GET", `/api/v1/host/${encodeURIComponent(hostKey)}/provider/pending`, undefined, signal);
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

  /** Open a range from the head the dashboard has accepted to the one just reported. Answers `{rangeId, ...}`. */
  async openRange({ machineId, path, baseHead, targetHead, cursorRevision, reporter }, { signal } = {}) {
    return this.#call("POST", `/instances/${encodeURIComponent(reporter)}/commit-ranges`, {
      machineId, worktree: { raw: path, canonical: path }, baseHead, targetHead, cursorRevision,
    }, signal);
  }

  /** One batch of a range, oldest commits first. A retry must send the identical batch: the dashboard hashes it. */
  async sendBatch(rangeId, { reporter, batchIndex, afterSha, commits, hasMore }, { signal } = {}) {
    return this.#call("POST", `/commit-ranges/${encodeURIComponent(rangeId)}/batches`, {
      bridgeInstanceId: reporter, batchIndex, afterSha, commits, hasMore,
    }, signal);
  }

  /** History that cannot be reported as a range (a reset, a rebase, a missing commit): coverage moves, with a gap. */
  async resync({ machineId, path, oldHead, newHead, reason, cursorRevision, reporter }, { signal } = {}) {
    return this.#call("POST", `/instances/${encodeURIComponent(reporter)}/resync`, {
      machineId, worktree: { raw: path, canonical: path }, oldHead, newHead, reason, cursorRevision,
    }, signal);
  }

  async #call(method, path, body, stop) {
    const key = String((await this.#credential()) || "");
    if (!key) throw new DashboardApiError("no credential for aify-dashboard on this host");
    let response;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method,
        headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: stop ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), stop]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        { status: response.status, code: String(parsed?.code || ""), current: parsed?.current ?? null });
    }
    return parsed;
  }
}
