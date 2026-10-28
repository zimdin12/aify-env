// One sender owns G6 collection, per-entry acknowledgements and physical-URL occupancy.
// No agent lifecycle or HTTP loopback read. Failed bodies are discarded, not queued.
// A sender given `admit` (the residents role's, B1) composes and sends only inside an operation it admits, and asks
// that operation again before each post: a population whose role is gone is neither composed nor sent.
//
// RETIREMENT (B5) is the one body sent after stop(). `retire({signal})` proves the key holds nothing (the host's
// typed proof over every lifetime the publisher numbered), numbers the `retired` body, and posts it only to the
// destinations stop() froze that a fresh registry read still names with the same signature. It is its own request,
// outside occupancy and never through #send, and `signal` (the shutdown slot's one deadline) ends it. The outcome is
// what THIS SENDER knows, never what a receiver did: `confirmed` only when every destination ever sent a body is
// still authorized and every authorized one answered 204 in time; anything else is `unconfirmed`, and only each
// receiver's cursor says whether it retired the key.
import { randomUUID } from "node:crypto";
import { AgentStatePublisher } from "./agent-state-publisher.mjs";
import { readAgentStates } from "./agent-state-read.mjs";
import { readServices, registryIsReadable, serviceIdentity } from "./services.mjs";
import { credentialForTarget } from "./credential-resolve.mjs";
import { CREDENTIAL_ABSENT, CREDENTIAL_OK, CREDENTIAL_FAULTS, credentialRefIsValid } from "./credential-store.mjs";

/** How often this aify-env reports in full: the snapshot epoch, the daemon's evaluation timer and the interval every
 * body announces as `reportEveryMs` (decision 2: comms derives "not reporting" from it). The one place it is set. */
export const REPORT_EVERY_MS = 60_000;
/** The operation a sender with no role to ask works inside: always live. */
const UNGATED = Object.freeze({ live: () => true, done() {} });
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate before URL interpretation or credential fallback. Preserve every accepted literal. */
function destination(service) {
  // WHO THE ENTRY IS by the one rule plugin selection and the advertiser use, so a spaced registry key is the same
  // service here as everywhere else rather than a second slot under a name nothing else recognises.
  const { name, endpoint, admitted } = serviceIdentity(service);
  if (!admitted) return null;
  const option = service.agentState;
  if (!plain(option) || Object.keys(option).some((key) => key !== "path" && key !== "credentialRef")) return null;
  const route = option.path;
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(route)) return null;
  const named = Object.hasOwn(option, "credentialRef");
  if (named && (typeof option.credentialRef !== "string" || !credentialRefIsValid(option.credentialRef))) return null;
  try {
    const base = new URL(endpoint);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return null;
    const resolved = new URL(route, endpoint);
    if (resolved.origin !== base.origin) return null;
    const physical = new URL(resolved);
    physical.hash = ""; // Fetch never transmits fragments. These aliases share one request lock.
    const credentialTarget = named ? { name, credentialRef: option.credentialRef, keyEnv: [] } : { ...service, name, endpoint };
    return { name, url: resolved.href, physicalUrl: physical.href, credentialTarget,
      signature: JSON.stringify([resolved.href, credentialTarget.credentialRef, credentialTarget.keyEnv]) };
  } catch { return null; }
}

export class AgentStateSender {
  #publisher;
  #observation;
  #registry;
  #credential;
  #credentialOptions;
  #fetch;
  #now;
  #bootAt;
  #timeoutMs;
  #setTimeout;
  #clearTimeout;
  #report;
  #slots = new Map();
  #occupied = new Map();
  #collecting = null;
  #again = null;
  #stopped = false;
  #admit;
  /** name -> target of the slots current at stop(), frozen before they are cleared. */
  #terminal = null;
  /** The signature of every destination a body was posted to. */
  #everSent = new Set();

  constructor({ identity, stateHost, definitions, observedHarnesses, lifecycle, cwdRoots = null, screens = () => [], readRegistry,
    credentialOptions = () => ({}), credential = credentialForTarget, fetchImpl = fetch, nowMs = Date.now,
    timeoutMs = 5000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, report = () => {}, admit = null }) {
    this.#admit = admit ?? (() => UNGATED);
    this.#publisher = new AgentStatePublisher({ incarnationId: randomUUID(), nowMs, reportEveryMs: REPORT_EVERY_MS, ...identity });
    this.#observation = { stateHost, definitions, observedHarnesses, lifecycle, cwdRoots, screens };
    this.#registry = readRegistry;
    this.#credential = credential;
    this.#credentialOptions = credentialOptions;
    this.#fetch = fetchImpl;
    this.#now = nowMs;
    this.#bootAt = nowMs();
    this.#timeoutMs = timeoutMs;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#report = report;
  }

  /** Coalesce collection only. Remote settlement never blocks another destination's next tick. */
  tick() {
    if (this.#stopped) return Promise.resolve();
    // ONE MORE AFTER THE ONE IN FLIGHT. A change can land after that evaluation read its facts, and a tick that only
    // joined it would leave the change for the next sweep, which is the lag the operator saw after a stop. Every tick
    // asked meanwhile shares that one follow-up.
    if (this.#collecting) {
      this.#again ??= this.#collecting.catch(() => {}).then(() => { this.#again = null; return this.tick(); });
      return this.#again;
    }
    this.#collecting = this.#evaluate().finally(() => { this.#collecting = null; });
    return this.#collecting;
  }

  /** Synchronous resource cleanup only. No offline publication; abort is not request settlement. */
  stop() {
    this.#terminal ??= new Map([...this.#slots].map(([name, slot]) => [name, slot.target]));
    this.#stopped = true;
    for (const slot of this.#slots.values()) this.#retire(slot);
    this.#slots.clear();
    for (const request of this.#occupied.values()) this.#abort(request);
  }

  /**
   * Retire this sender's key (B5). Resolves with {outcome, reason, destinations} once every destination answered or
   * `signal` aborted; the line is written either way, before the promise settles.
   *
   * @param {{signal?: AbortSignal|null}} [options]
   */
  async retire({ signal = null } = {}) {
    if (!this.#stopped) this.stop();
    const say = (line) => { try { this.#report(`agent state retirement: ${line}`); } catch { /* cannot kill a daemon */ } };
    let proof;
    try { proof = this.#observation.stateHost?.retirementProof?.(this.#publisher.published); } catch { proof = null; }
    if (!proof?.holds) {
      say(`not-proven (${proof?.unproven?.length ?? 0} lifetimes)`);
      return { outcome: "not-proven", reason: proof?.reason ?? "no proof", destinations: {} };
    }
    const publication = this.#publisher.retire();
    const destinations = {};
    const controllers = [];
    let notAuthorized = false;
    // Whether the authorized set was computed at all: a deadline before it is no answer from anybody, never a vacuous yes.
    let known = false;
    let settled = null;
    const finish = (why) => {
      if (settled) return settled;
      const cut = !known || Object.values(destinations).includes("pending");
      for (const name of Object.keys(destinations)) if (destinations[name] === "pending") destinations[name] = `unconfirmed (${why})`;
      const confirmed = known && !notAuthorized && Object.values(destinations).every((result) => result === "confirmed");
      const reason = notAuthorized ? "destination-not-authorized" : confirmed ? "" : cut ? why : "not-applied";
      const listed = Object.entries(destinations).map(([name, result]) => `${JSON.stringify(name)}=${result}`).join(", ");
      say(`${confirmed ? "confirmed" : `unconfirmed${reason ? `, ${reason}` : ""}`} [${listed}]`);
      settled = { outcome: confirmed ? "confirmed" : "unconfirmed", reason, destinations: { ...destinations } };
      return settled;
    };
    // A DEADLINE THAT HAS ALREADY PASSED ENDS THE RETIREMENT HERE, before any registry, credential or post work: the
    // body above is numbered (so nothing later can be), and nothing leaves this process for it.
    if (signal?.aborted) return finish("deadline");
    // Every boundary below asks this. A deadline passing DURING a step settles the outcome at once (the abort listener
    // calls finish synchronously), so a settled outcome is the one fact each boundary needs; the entry guard above is
    // the one owner of a deadline that passed before the retirement began.
    const expired = () => settled !== null;
    const ended = new Promise((resolve) => {
      signal?.addEventListener("abort", () => { for (const c of controllers) c.abort(); finish("deadline"); resolve(); }, { once: true });
    });
    const work = (async () => {
      let fresh = new Map();
      try {
        const registry = await this.#registry();
        if (!registryIsReadable(registry)) throw new Error("registry-unreadable");
        for (const service of readServices(registry)) {
          if (!Object.hasOwn(service, "agentState")) continue;
          const target = destination(service);
          if (target) fresh.set(target.name, target);
        }
      } catch { fresh = new Map(); }
      if (expired()) return;
      const authorized = [...(this.#terminal ?? new Map()).values()].filter((target) => fresh.get(target.name)?.signature === target.signature);
      const signatures = new Set(authorized.map((target) => target.signature));
      notAuthorized = [...this.#everSent].some((signature) => !signatures.has(signature));
      for (const target of authorized) destinations[target.name] = "pending";
      known = true;
      await Promise.allSettled(authorized.map(async (target) => {
        const controller = new AbortController();
        controllers.push(controller);
        if (expired()) return;
        try {
          const credential = await this.#credential(target.credentialTarget, this.#credentialOptions());
          if (expired()) return;
          if (credential?.state !== CREDENTIAL_OK && credential?.state !== CREDENTIAL_ABSENT) {
            destinations[target.name] = "unconfirmed (credential)"; return;
          }
          const headers = { "Content-Type": "application/json" };
          if (credential.state === CREDENTIAL_OK) headers["x-aify-agent-state-key"] = credential.value;
          if (expired()) return;
          const answer = await this.#fetch(target.url, { method: "POST", headers, body: JSON.stringify(publication.body),
            redirect: "error", signal: controller.signal });
          if (expired()) return;
          destinations[target.name] = answer?.status === 204 && answer.ok === true && !answer.redirected
            ? "confirmed" : "unconfirmed (not-applied)";
        } catch {
          if (!settled) destinations[target.name] = `unconfirmed (${controller.signal.aborted ? "aborted" : "transport-failed"})`;
        }
      }));
    })();
    await Promise.race([work.catch(() => {}), ended]);
    return finish(signal?.aborted ? "deadline" : "unanswered");
  }

  #notice(name, outcome) {
    if (this.#stopped) return;
    try { this.#report(`agent state ${JSON.stringify(name)}: ${outcome}`); } catch { /* reporting cannot kill a daemon */ }
  }

  #current(slot) { return !this.#stopped && this.#slots.get(slot.target.name) === slot; }

  #clearTimer(request) {
    if (request.timer !== undefined) this.#clearTimeout(request.timer);
    request.timer = undefined;
  }

  #abort(request) { this.#clearTimer(request); request.controller.abort(); }

  #retire(slot) {
    const request = this.#occupied.get(slot.target.physicalUrl);
    if (request?.slot === slot) this.#abort(request);
  }

  #reconcile(services) {
    const desired = new Map();
    for (const service of services) {
      if (!Object.hasOwn(service, "agentState")) continue;
      const target = destination(service);
      if (target) desired.set(target.name, target);
      else this.#notice(serviceIdentity(service).name, "invalid-target");
    }
    for (const [name, slot] of this.#slots) {
      if (desired.get(name)?.signature !== slot.target.signature) {
        this.#retire(slot);
        this.#slots.delete(name);
      }
    }
    for (const [name, target] of desired) {
      if (!this.#slots.has(name)) this.#slots.set(name, { target, view: null, snapshotEpoch: -1 });
    }
  }

  async #evaluate() {
    let registry;
    try {
      registry = await this.#registry();
      if (!registryIsReadable(registry)) throw new Error("registry-unreadable");
    } catch { this.#notice("registry", "registry-unavailable"); return; }
    if (this.#stopped) return;
    this.#reconcile(readServices(registry));
    if (![...this.#slots.values()].some((slot) => !this.#occupied.has(slot.target.physicalUrl))) return;
    const composing = this.#admit();
    if (!composing) { this.#notice("population", "not-owner"); return; }
    let body;
    try {
      ({ body } = await readAgentStates(this.#observation));
      if (this.#stopped || !composing.live()) return;
    } finally { composing.done(); }
    const enumeration = { ...body, reason: "observation-incomplete" };
    for (const slot of this.#slots.values()) {
      if (this.#occupied.has(slot.target.physicalUrl)) continue;
      const sending = this.#admit();
      if (!sending) return;
      // Reserve BEFORE any asynchronous credential read. A registry alias uses the same physical lock.
      const request = { slot, controller: new AbortController() };
      this.#occupied.set(slot.target.physicalUrl, request);
      void this.#send(request, enumeration, sending);
    }
  }

  async #send(request, enumeration, sending) {
    const { slot, controller } = request;
    const { target } = slot;
    try {
      const credential = await this.#credential(target.credentialTarget, this.#credentialOptions());
      if (!this.#current(slot) || controller.signal.aborted) return;
      if (credential?.state !== CREDENTIAL_OK && credential?.state !== CREDENTIAL_ABSENT) {
        this.#notice(target.name, CREDENTIAL_FAULTS.includes(credential?.state) ? credential.state : "credential-unavailable");
        return;
      }
      // The role is asked at the effect, before a publication number is spent on a body that must not go.
      if (!sending.live()) return;
      const epoch = Math.max(0, Math.floor((this.#now() - this.#bootAt) / REPORT_EVERY_MS));
      const publication = !enumeration.complete || !slot.view || epoch > slot.snapshotEpoch
        ? this.#publisher.snapshot(enumeration) : this.#publisher.changes(enumeration, slot.view);
      if (!publication) return;
      const headers = { "Content-Type": "application/json" };
      if (credential.state === CREDENTIAL_OK) headers["x-aify-agent-state-key"] = credential.value;
      request.timer = this.#setTimeout(() => this.#abort(request), this.#timeoutMs);
      request.timer?.unref?.();
      this.#everSent.add(target.signature);
      const answer = await this.#fetch(target.url, { method: "POST", headers, body: JSON.stringify(publication.body),
        redirect: "error", signal: controller.signal });
      if (!this.#current(slot) || controller.signal.aborted) return;
      // Only C5's proven application response. Never read arbitrary bodies or renew on duplicate/stale/conflict.
      if (answer?.status !== 204 || answer.ok !== true || answer.redirected) {
        this.#notice(target.name, "not-applied"); return;
      }
      if (publication.view) {
        slot.view = publication.view;
        if (publication.body.kind === "snapshot") slot.snapshotEpoch = epoch;
      }
    } catch {
      if (this.#current(slot)) this.#notice(target.name, controller.signal.aborted ? "request-aborted" : "transport-failed");
    } finally {
      sending.done();
      this.#clearTimer(request);
      // Do not release on abort request, only when the credential/fetch operation has actually settled.
      if (this.#occupied.get(target.physicalUrl) === request) this.#occupied.delete(target.physicalUrl);
      // A quiet acknowledged alias must not monopolize an unacknowledged alias on every tick.
      if (this.#current(slot)) {
        this.#slots.delete(target.name);
        this.#slots.set(target.name, slot);
      }
    }
  }
}
