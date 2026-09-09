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
    // WHAT KIND OF CLAIMER THIS IS, added 2026-09-04 (external review, Round 8 H4).
    //
    // Supersession arbitrated on START TIME alone, so a legacy aify-comms environment bridge -- one
    // on a host that has not re-run install.sh -- could start later than this host and take the
    // claimer role from it. It would then be the only party the service lets claim, which is the
    // collision the environment tier exists to end, arriving from the direction nobody was watching.
    //
    // The service cannot tell the two apart without being told: this identity and a legacy bridge's
    // carry exactly the same three fields. So it is told. `bridgeKind` reaches the service inside
    // `metadata` with the rest of the identity, and the service prefers a host tier over a bridge
    // regardless of start time -- which is what `TARGET_ARCHITECTURE.md` has said all along.
    //
    // BOTH ENDS OR NEITHER: a service that does not read this is unaffected, and a service that does
    // read it treats an absent value as "legacy", which is what every pre-0.6.2 sender is.
    bridgeKind: HOST_TIER_BRIDGE_KIND,
  };
}

/** What this host calls itself when it registers. The service prefers this over a legacy bridge. */
export const HOST_TIER_BRIDGE_KIND = "aify-env";

/**
 * Who the service records as having asked for a session control from here.
 *
 * THIS TIER, BY NAME. The field ends up on the control row and in the operator's history, so it has
 * to answer "who did this" truthfully. It is not a person and must never be guessed from an
 * environment variable: a control attributed to whichever agent happened to be in `AIFY_AGENT_ID`
 * would put somebody else's name on a restart they did not ask for.
 */
export const HOST_TIER_CONTROL_ACTOR = "aify-env";

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
        // Carries X-API-Key, so it must never follow a redirect to wherever a 3xx points.
        redirect: "manual",
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
    // `bridgeId` TOP-LEVEL, the rest inside `metadata`, because that is where the service reads
    // them. Sending `bridgeStartedAt` alongside `bridgeId` at the top level looked right and failed
    // silently: supersession arbitration reads the incoming start time from `metadata`, found none,
    // and took the "keep the existing bridge" branch -- returning `ok: true` while stamping nothing.
    // A heartbeat that is accepted and ignored is indistinguishable from one that worked, which is
    // why this cost a live debugging session rather than a test.
    const { bridgeId, ...bridgeMetadata } = this.#identity;
    return this.#send("POST", "/environments/heartbeat", {
      ...advertisement,
      bridgeId,
      metadata: { ...(advertisement.metadata || {}), ...bridgeMetadata },
    });
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

  /**
   * Ask for the terminal work this environment has been given.
   *
   * A SECOND LONG-POLL, beside the spawn claim, because they answer different questions. A spawn
   * claim asks "is there an agent to register here"; this asks "is there a process to run". The
   * aify-comms bridge kept them as two loops for the same reason, and merging them would make one
   * quiet queue delay the other.
   */
  async claimControls({ environmentId, waitMs = CLAIM_WAIT_MS } = {}) {
    return this.#send("POST", "/terminals/controls/claim", {
      environmentId,
      bridgeId: this.#identity.bridgeId,
      waitMs,
    }, CLAIM_TIMEOUT_MS);
  }

  /**
   * EVERYTHING NEEDED TO RUN ONE TERMINAL, from the tier that composed it.
   *
   * The service owns the launch -- the program, its argv, and the aify-owned environment -- because
   * it is the tier that knows what a runtime needs. This host adds only what the service cannot
   * know: its own base environment, and any directory that must exist on this machine. Asking for
   * it is what makes aify-env a process host rather than a second implementation of aify-comms.
   */
  async launch(terminalId) {
    return this.#send("GET", `/terminals/${encodeURIComponent(terminalId)}/launch`, undefined);
  }

  /**
   * A terminal's output, and eventually how it ended.
   *
   * THE SERVICE LEARNS A WORKER IS ALIVE ONLY FROM THIS. Nothing else reports it: the process runs
   * on this host, and the row the service reconciles against is written by these posts. Measured
   * 2026-09-03, when this call did not exist: fourteen workers ran perfectly, the service heard
   * nothing, reconciled every terminal as a dead ghost, and asked for a replacement — which this
   * host dutifully started beside the one still running.
   *
   * `bridgeId` travels so the service can tell whose terminal this is, the same identity the
   * heartbeat and the claim carry.
   */
  async terminalOutput(terminalId, body = {}) {
    return this.#send("POST", `/terminals/${encodeURIComponent(terminalId)}/output`, {
      ...body,
      bridgeId: this.#identity.bridgeId,
    });
  }

  /** Say what became of one terminal control. Every claimed control is reported, including the ones
   *  that failed: a control the service never hears about again is one it hands to nobody else. */
  async reportControl(controlId, patch = {}) {
    return this.#send("PATCH", `/terminals/controls/${encodeURIComponent(controlId)}`, patch);
  }

  /**
   * Every agent this service knows, so an operator on this host can be shown the ones it could
   * start. Read-only, and the only call here that asks about agents rather than about work.
   */
  async agents() {
    return this.#send("GET", "/agents", undefined);
  }

  /** One agent's sessions, which is what a restart actually acts on. */
  async sessionsFor(agentId) {
    return this.#send("GET", `/sessions?agentId=${encodeURIComponent(agentId)}`, undefined);
  }

  /**
   * Ask the service to restart one session -- the dashboard's own path for bringing an agent back.
   *
   * NO `body` FIELD, EVER, AND THAT IS NOT A STYLE CHOICE. The route stores `body` as the spawn
   * request's `initial_message`, and the service turns a non-empty one into a real `type=request`
   * message plus a dispatch run addressed to the agent that just came up. Measured on this fleet:
   * all 21 self-issued spawn requests followed one of those, 45 to 75 seconds later, because a
   * freshly-started agent read the receipt as an instruction and restarted itself. A control has no
   * brief. The signature takes none, so a caller cannot supply one.
   *
   * `onlyIfNoLiveSession` CARRIES THE CALLER'S PRECONDITION to the authority. A caller that
   * chose this session because the agent had no live worker read that a round trip ago, and a
   * worker can start in between -- so the belief travels with the request and the service
   * refuses with 409 if it no longer holds. Omitted, the restart is unconditional, which is
   * what the dashboard's own button means.
   */
  async controlSession(sessionId, action = "restart", { onlyIfNoLiveSession = false } = {}) {
    return this.#send("POST", `/sessions/${encodeURIComponent(sessionId)}/control`, {
      action: String(action),
      from_agent: HOST_TIER_CONTROL_ACTOR,
      only_if_no_live_session: onlyIfNoLiveSession === true,
    });
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
