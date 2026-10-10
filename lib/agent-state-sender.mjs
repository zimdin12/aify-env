// One sender owns G6 collection, per-entry acknowledgements and physical-URL occupancy.
// No agent lifecycle or HTTP loopback read. Failed bodies are discarded, not queued.
import { randomUUID } from "node:crypto";
import { AgentStatePublisher } from "./agent-state-publisher.mjs";
import { readAgentStates } from "./agent-state-read.mjs";
import { readServices, registryIsReadable } from "./services.mjs";
import { credentialForTarget } from "./credential-resolve.mjs";
import { CREDENTIAL_ABSENT, CREDENTIAL_OK, CREDENTIAL_FAULTS, credentialRefIsValid } from "./credential-store.mjs";

const SNAPSHOT_MS = 60_000;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate before URL interpretation or credential fallback. Preserve every accepted literal. */
function destination(service) {
  const option = service.agentState;
  if (!plain(option) || Object.keys(option).some((key) => key !== "path" && key !== "credentialRef")) return null;
  const route = option.path;
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(route)) return null;
  const named = Object.hasOwn(option, "credentialRef");
  if (named && (typeof option.credentialRef !== "string" || !credentialRefIsValid(option.credentialRef))) return null;
  try {
    const base = new URL(service.endpoint);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return null;
    const resolved = new URL(route, service.endpoint);
    if (resolved.origin !== base.origin) return null;
    const physical = new URL(resolved);
    physical.hash = ""; // Fetch never transmits fragments. These aliases share one request lock.
    const credentialTarget = named ? { name: service.name, credentialRef: option.credentialRef, keyEnv: [] } : service;
    return { name: service.name, url: resolved.href, physicalUrl: physical.href, credentialTarget,
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
  #stopped = false;

  constructor({ identity, stateHost, definitions, observedHarnesses, lifecycle, readRegistry,
    credentialOptions = () => ({}), credential = credentialForTarget, fetchImpl = fetch, nowMs = Date.now,
    timeoutMs = 5000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, report = () => {} }) {
    this.#publisher = new AgentStatePublisher({ incarnationId: randomUUID(), ...identity });
    this.#observation = { stateHost, definitions, observedHarnesses, lifecycle };
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
    if (!this.#collecting) {
      this.#collecting = this.#evaluate().finally(() => { this.#collecting = null; });
    }
    return this.#collecting;
  }

  /** Synchronous resource cleanup only. No offline publication; abort is not request settlement. */
  stop() {
    this.#stopped = true;
    for (const slot of this.#slots.values()) this.#retire(slot);
    this.#slots.clear();
    for (const request of this.#occupied.values()) this.#abort(request);
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
      else this.#notice(service.name, "invalid-target");
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
    const { body } = await readAgentStates(this.#observation);
    if (this.#stopped) return;
    const enumeration = { ...body, reason: "observation-incomplete" };
    for (const slot of this.#slots.values()) {
      if (this.#occupied.has(slot.target.physicalUrl)) continue;
      // Reserve BEFORE any asynchronous credential read. A registry alias uses the same physical lock.
      const request = { slot, controller: new AbortController() };
      this.#occupied.set(slot.target.physicalUrl, request);
      void this.#send(request, enumeration);
    }
  }

  async #send(request, enumeration) {
    const { slot, controller } = request;
    const { target } = slot;
    try {
      const credential = await this.#credential(target.credentialTarget, this.#credentialOptions());
      if (!this.#current(slot) || controller.signal.aborted) return;
      if (credential?.state !== CREDENTIAL_OK && credential?.state !== CREDENTIAL_ABSENT) {
        this.#notice(target.name, CREDENTIAL_FAULTS.includes(credential?.state) ? credential.state : "credential-unavailable");
        return;
      }
      const epoch = Math.max(0, Math.floor((this.#now() - this.#bootAt) / SNAPSHOT_MS));
      const publication = !enumeration.complete || !slot.view || epoch > slot.snapshotEpoch
        ? this.#publisher.snapshot(enumeration) : this.#publisher.changes(enumeration, slot.view);
      if (!publication) return;
      const headers = { "Content-Type": "application/json" };
      if (credential.state === CREDENTIAL_OK) headers["x-aify-agent-state-key"] = credential.value;
      request.timer = this.#setTimeout(() => this.#abort(request), this.#timeoutMs);
      request.timer?.unref?.();
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
