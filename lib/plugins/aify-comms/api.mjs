// The three calls this plugin makes to aify-comms, and the identity it makes them under.
//
// THIS IS THE ONLY FILE IN aify-env THAT NAMES AN aify-comms ENDPOINT. That is the boundary the
// whole plugin split exists to draw: a module that knows a service's URL belongs to that service,
// and everything else here is general host capability. A gate enforces it -- see the plugin's
// boundary test -- because the last boundary was prose and prose let a document claim completion for
// eight days while the thing it described was untrue.
//
// THE CREDENTIAL IS FETCHED PER CALL, never captured. A key can be rotated while this host runs, and
// a client holding a boot-time copy keeps presenting the old one until restarted. Measured
// 2026-09-02: a credential was stored, the process that needed it had read its absence at boot, and
// every request 401'd for hours while both sides reported healthy.

import { randomUUID } from "node:crypto";

/** How long a request may take before it is abandoned. A claim holds the connection open on purpose
 *  (long-poll), so it gets its own, larger budget rather than one shared number that must suit both. */
export const REQUEST_TIMEOUT_MS = 10_000;
export const CLAIM_TIMEOUT_MS = 35_000;

/** How long the service will hold a claim open waiting for work. Kept BELOW `CLAIM_TIMEOUT_MS`, so a
 *  quiet period ends with the service answering "nothing" rather than with this side timing out --
 *  a timeout and an idle claim look identical from here, and one of them is a fault. */
export const CLAIM_WAIT_MS = 25_000;

/**
 * Who this host is, as a claimer.
 *
 * MINTED ONCE PER PROCESS. `bridgeId` is what the service arbitrates supersession on: two claimers
 * sharing an id are indistinguishable, and a new id per request would make every beat look like a
 * different claimer arriving. It is deliberately NOT derived from the machine -- restarting must
 * read as a new claimer, because the previous one's in-flight work is no longer being tracked.
 */
export function mintBridgeIdentity({ version = "", now = () => new Date() } = {}) {
  return {
    bridgeId: randomUUID(),
    bridgeVersion: String(version || ""),
    bridgeStartedAt: now().toISOString(),
  };
}

/** A failed call, carrying the status so a caller can tell "refused" from "unreachable". */
export class CommsApiError extends Error {
  constructor(message, { status = 0, path = "" } = {}) {
    super(message);
    this.name = "CommsApiError";
    this.status = status;
    this.path = path;
  }
}

export class CommsApi {
  #endpoint;
  #credential;
  #fetch;
  #identity;

  /**
   * @param {object} deps
   * @param {string} deps.endpoint      the service root, e.g. http://127.0.0.1:8800
   * @param {() => Promise<string>} deps.credential  resolved per call, never cached here
   * @param {object} deps.identity      from `mintBridgeIdentity`
   * @param {Function} [deps.fetchImpl] injected so tests reach no network
   */
  constructor({ endpoint, credential, identity, fetchImpl = globalThis.fetch } = {}) {
    this.#endpoint = String(endpoint || "").replace(/\/+$/, "");
    if (!this.#endpoint) throw new TypeError("CommsApi needs an endpoint");
    if (typeof credential !== "function") throw new TypeError("CommsApi needs a credential resolver");
    if (!identity || !identity.bridgeId) throw new TypeError("CommsApi needs a bridge identity");
    this.#credential = credential;
    this.#identity = identity;
    this.#fetch = fetchImpl;
  }

  /** The identity every call carries, exposed so a caller can report which claimer it is. */
  get identity() { return { ...this.#identity }; }

  async #send(method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const key = String((await this.#credential()) || "");
    const headers = { "Content-Type": "application/json" };
    // A host with no key sends none rather than an empty header: an empty `X-API-Key` is a WRONG
    // key to a service that requires one, and the two produce different diagnoses.
    if (key) headers["X-API-Key"] = key;
    let response;
    try {
      response = await this.#fetch(`${this.#endpoint}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Unreachable is not the same as refused, and a caller must be able to tell them apart: one
      // means retry, the other means a person has to change something.
      throw new CommsApiError(String(error?.message || error), { status: 0, path });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new CommsApiError(
        `${method} ${path} -> ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        { status: response.status, path },
      );
    }
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }

  /**
   * Say this host is a CLAIMER for this environment.
   *
   * THE `bridgeId` IS THE WHOLE POINT. The service stamps `metadata.bridgeLastSeen` only for a
   * heartbeat carrying one, and `/spawn` reads that field to decide whether anything can claim. This
   * host's ordinary advertisement omits the id by design -- it describes the host rather than
   * offering to run things -- so without this call the row reads `online` and every spawn is refused.
   */
  async heartbeat(advertisement = {}) {
    return this.#send("POST", "/environments/heartbeat", { ...advertisement, ...this.#identity });
  }

  /** Ask for one spawn request, waiting up to `CLAIM_WAIT_MS` for one to appear. */
  async claim({ environmentId, machineId = "" } = {}) {
    return this.#send("POST", "/spawn-requests/claim", {
      environmentId,
      machineId,
      bridgeId: this.#identity.bridgeId,
      waitMs: CLAIM_WAIT_MS,
    }, CLAIM_TIMEOUT_MS);
  }

  /** Report what became of a claimed request. Carries the bridgeId so the service can tell whether
   *  the claimer reporting is still the one it handed the work to. */
  async report(spawnRequestId, patch = {}) {
    return this.#send("PATCH", `/spawn-requests/${encodeURIComponent(spawnRequestId)}`, {
      ...patch,
      bridgeId: this.#identity.bridgeId,
    });
  }
}
