// The residents role: one aify-env per aify home holds it, by holding an OS lock (B1 contract items 3, 5, 7, 8).
//
// THE HOLDER IS THE ONE PROCESS LISTENING ON THE ROLE ENDPOINT (lib/residents-home.mjs names it). The bind is atomic
// and exclusive and the kernel releases it when the process ends, so there is no lease to expire: a paused holder
// still holds, and a crashed one has released. Any failed bind is no role, reported; nothing is acquired by reading.
//
// ONE OBJECT, because the role has identity and state: where it is (not held, holding, releasing), the
// endpoint it holds, the generation it took under that endpoint, and the operations entered while it held. Its
// states, in order:
//   acquire()  bind, then take the generation under the bind; any failure closes the endpoint and leaves no role
//   enter()    admit one resident operation, or null (`not-owner`) unless holding; the operation's `live()` asks the
//              lock again at the moment of its effect, so an operation that outlives the role cannot apply
//   release()  stop admitting, wait a bounded time for entered operations, then close the endpoint even when the
//              wait timed out. No withdrawal is published: the successor's higher generation supersedes on the key.

import fs from "node:fs";
import net from "node:net";

import { crossOsHomeReason, homeIdentity, residentsPublisherInstance, roleEndpoint } from "./residents-home.mjs";
import { takeResidentsGeneration } from "./residents-generation.mjs";

/** How long a release waits for entered operations before it closes the endpoint anyway. */
const RELEASE_WAIT_MS = 1000;

/** An error a guarded effect throws when the role is gone at the moment it would apply. */
export function notOwnerError() {
  return Object.assign(new Error("the residents role is not held"), { code: "NOT_OWNER" });
}

/** Listen on the endpoint; resolve the server once bound, reject with the bind's own error. */
function listenOn(endpoint) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(endpoint, () => { server.removeListener("error", reject); resolve(server); });
  });
}

export class ResidentsRole {
  #aifyHome;
  #platform;
  #realpath;
  #listen;
  #nowMs;
  #state = "not-held";
  #reason = "not-attempted";
  #server = null;
  #endpoint = null;
  #publisherInstance = null;
  #generation = null;
  #entered = new Set();
  /** Set while a release waits: called as each entered operation finishes. */
  #settle = null;
  #acquiring = null;

  constructor({ aifyHome, platform = process.platform, realpath = fs.realpathSync.native,
    listen = listenOn, nowMs = Date.now }) {
    if (typeof aifyHome !== "string" || !aifyHome) throw new TypeError("a residents role needs its aify home");
    this.#aifyHome = aifyHome;
    this.#platform = platform;
    this.#realpath = realpath;
    this.#listen = listen;
    this.#nowMs = nowMs;
  }

  get generation() { return this.#generation; }
  get publisherInstance() { return this.#publisherInstance; }
  get endpoint() { return this.#endpoint; }

  /** Holding and still bound: the lock itself is asked, not a remembered flag. */
  holds() { return this.#state === "holding" && this.#server?.listening === true; }

  /** What /health says about the role. No path or identity text, only the names derived from it. */
  report() {
    return { held: this.holds(), state: this.#state, reason: this.holds() ? "" : this.#reason,
      generation: this.#generation, publisherInstance: this.#publisherInstance, endpoint: this.#endpoint };
  }

  /** @returns {Promise<{held: boolean, reason: string}>} concurrent calls share one attempt */
  acquire() {
    if (this.#state !== "not-held") return Promise.resolve({ held: this.holds(), reason: this.#reason });
    this.#acquiring ??= this.#attempt().finally(() => { this.#acquiring = null; });
    return this.#acquiring;
  }

  async #attempt() {
    const refuse = (reason) => { this.#reason = reason; return { held: false, reason }; };
    try { fs.mkdirSync(this.#aifyHome, { recursive: true }); } catch { /* homeIdentity reports the home it cannot resolve */ }
    const home = homeIdentity(this.#aifyHome, { platform: this.#platform, realpath: this.#realpath });
    if (!home.ok) return refuse(home.reason);
    const crossOs = crossOsHomeReason(home.identity, { platform: this.#platform });
    if (crossOs) return refuse(crossOs);
    const endpoint = roleEndpoint(home.identity, this.#platform);
    if (!endpoint) return refuse(`unsupported-platform: ${this.#platform}`);
    this.#endpoint = endpoint;
    this.#publisherInstance = residentsPublisherInstance(home.identity);
    let server;
    try { server = await this.#listen(endpoint); }
    catch (error) { return refuse(error?.code === "EADDRINUSE" ? "held-elsewhere" : `bind-failed: ${error?.code || "error"}`); }
    this.#server = server;
    // A server that stops listening for any reason has lost the role: the lock is the authority, not this object.
    server.on("close", () => { if (this.#state === "holding") { this.#state = "not-held"; this.#reason = "endpoint-closed"; } });
    server.on("error", () => {});
    const taken = takeResidentsGeneration(this.#aifyHome, { nowMs: this.#nowMs(),
      guard: () => { if (this.#server !== server || !server.listening) throw notOwnerError(); } });
    if (!taken.ok) {
      this.#server = null;
      await new Promise((resolve) => server.close(() => resolve()));
      return refuse(taken.reason);
    }
    this.#generation = taken.generation;
    this.#state = "holding";
    this.#reason = "";
    return { held: true, reason: "" };
  }

  /**
   * Admit one resident operation. Null while not holding, which the caller reports as `not-owner`. The operation's
   * `live()` is asked immediately before its effect; `guard()` throws NOT_OWNER instead. `done()` is required.
   */
  enter() {
    if (!this.holds()) return null;
    const operation = {
      live: () => this.holds() && this.#entered.has(operation),
      guard: () => { if (!operation.live()) throw notOwnerError(); },
      done: () => { this.#entered.delete(operation); this.#settle?.(); },
    };
    this.#entered.add(operation);
    return operation;
  }

  /**
   * The ordered release: stop admitting, wait for entered operations up to `waitMs`, close the endpoint. A crash
   * skips all three with the same outcome on the wire. Later `live()` answers are false: nothing entered applies.
   * The role is then not held, for `reason`; whether to try again is the caller's.
   *
   * @returns {Promise<{timedOut: boolean, abandoned: number}>}
   */
  async release({ waitMs = RELEASE_WAIT_MS, reason = "released" } = {}) {
    if (this.#acquiring) await this.#acquiring;
    const server = this.#server;
    this.#state = "releasing";
    this.#reason = reason;
    let timedOut = false;
    if (this.#entered.size) {
      timedOut = await new Promise((resolve) => {
        const timer = setTimeout(() => { this.#settle = null; resolve(true); }, waitMs);
        this.#settle = () => { if (!this.#entered.size) { clearTimeout(timer); this.#settle = null; resolve(false); } };
      });
    }
    const abandoned = this.#entered.size;
    this.#entered.clear();
    this.#server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    this.#state = "not-held";
    return { timedOut, abandoned };
  }
}
