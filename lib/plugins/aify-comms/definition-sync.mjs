// Keeping aify-comms' copy of this host's agent definitions current, and carrying out the changes the
// operator asks for there (P0 C3, C4).
//
// ONE PASS, every `REQUEST_POLL_MS`: claim the change requests made for this machine, apply each through
// the store (one lock hold each, `DefinitionStore.applyRequest`), report what happened, and then push
// the snapshot if anything was applied or the last push is `PUSH_INTERVAL_MS` old. The first pass
// pushes, so a plugin that starts publishes at once. A store edited from the command line is published
// by the next timed push.
//
// THE SERVICE MAY BE DOWN, and the store may be locked or awaiting the operator's settlement of an
// interrupted write. Each is recorded on `state` and retried by the next pass; none stops the loop.

import { CommsApiError } from "./api.mjs";

/** How often the snapshot is published when nothing changed here (C3: "every 60 s"). */
export const PUSH_INTERVAL_MS = 60_000;

/** How often to ask for change requests. A request expires unclaimed after ten minutes (C4); this is
 *  how long an operator waits to see one picked up. */
export const REQUEST_POLL_MS = 10_000;

/** The service's reason for an id refused at a revision it has already seen and since freed. That id
 *  is taken at this host's next fresh revision, so the sync publishes one at once. */
export const FREE_SINCE = "free since this revision was applied; a fresh revision defines it";

const reasonOf = (error) => (error instanceof CommsApiError
  ? `${error.status || "unreachable"}: ${error.message}`
  : String(error?.message || error));

export class DefinitionSync {
  #api;
  #store;
  #installed;
  #machineId;
  #log;
  #now;
  #lastPushAt = null;

  /** What the last pass did, for the plugin's state and the doctor. */
  state = { lastPush: "", lastPushError: "", published: null, requestsHandled: 0, lastRequestError: "" };

  /**
   * @param {object} deps
   * @param {object} deps.api        a `CommsApi`
   * @param {object} deps.store      a `DefinitionStore`
   * @param {() => Promise<Set<string>>|Set<string>} deps.installed  the harnesses this host can launch
   * @param {string} deps.machineId  this host's machine id, which the service fences on
   */
  constructor({ api, store, installed, machineId, log = () => {}, now = () => Date.now() }) {
    this.#api = api;
    this.#store = store;
    this.#installed = installed;
    this.#machineId = String(machineId || "");
    this.#log = log;
    this.#now = now;
  }

  /**
   * One pass for `environmentId`. Resolves `{outcome: "synced", applied}`; what failed is on `state`. A
   * push that failed is tried again by the next pass, since only a published one resets the interval.
   */
  async pass(environmentId) {
    let applied = 0;
    try {
      applied = await this.#applyRequests(environmentId);
      this.state.lastRequestError = "";
    } catch (error) {
      this.state.lastRequestError = reasonOf(error);
      this.#log(`aify-comms definition requests failed (${this.state.lastRequestError})`);
    }
    const due = this.#lastPushAt === null || this.#now() - this.#lastPushAt >= PUSH_INTERVAL_MS;
    if (applied > 0 || due) await this.push(environmentId);
    return { outcome: "synced", applied };
  }

  /** Claim, apply and report every request made for this machine. Returns how many were applied. */
  async #applyRequests(environmentId) {
    const answer = await this.#api.claimDefinitionRequests(environmentId, this.#machineId);
    let applied = 0;
    for (const request of answer?.requests || []) {
      const result = await this.#store.applyRequest(request, { installed: await this.#installed() });
      // REPORTED BEFORE THE PUSH (C4 step 5): a report that is lost is redelivered by the next claim,
      // and applying it again is recognised and writes nothing.
      await this.#api.reportDefinitionRequest(environmentId, request.id, this.#machineId, result);
      this.state.requestsHandled += 1;
      if (result.status === "done") applied += 1;
    }
    return applied;
  }

  /**
   * Publish the complete snapshot (C3). An incomplete one (an unreadable entry, an unlistable directory,
   * an unsettled interrupted write) is never published: the service would withdraw what it lacks.
   */
  async push(environmentId, { fresh = false } = {}) {
    let snapshot;
    try {
      snapshot = await this.#store.snapshot({ installed: await this.#installed(), fresh });
    } catch (error) {
      this.state.lastPushError = `the store: ${error?.message || error}`;
      this.#log(`aify-comms definitions not published (${this.state.lastPushError})`);
      return null;
    }
    if (!snapshot.complete) {
      this.state.lastPushError = `incomplete: ${JSON.stringify(snapshot.incomplete)}`;
      this.#log(`aify-comms definitions not published (${this.state.lastPushError})`);
      return null;
    }
    let answer;
    try {
      answer = await this.#api.pushDefinitions(environmentId, {
        machineId: this.#machineId, storeId: snapshot.storeId, revision: snapshot.revision,
        snapshotDigest: snapshot.snapshotDigest, entries: snapshot.entries,
      });
    } catch (error) {
      this.state.lastPushError = reasonOf(error);
      this.#log(`aify-comms definitions not published (${this.state.lastPushError})`);
      return null;
    }
    this.#lastPushAt = this.#now();
    this.state.lastPush = new Date(this.#lastPushAt).toISOString();
    this.state.lastPushError = "";
    this.state.published = { storeId: snapshot.storeId, revision: snapshot.revision };
    const freed = (answer?.refused || []).filter((refusal) => refusal.reason === FREE_SINCE);
    if (freed.length && !fresh) return this.push(environmentId, { fresh: true });
    return answer;
  }
}
