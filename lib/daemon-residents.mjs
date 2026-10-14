// A daemon's side of the residents role (B1): the role, and what holding it means for this daemon.
//
// Any aify-env, ordinary or dedicated, tries for the role at boot and on every sweep while it does not hold it; the
// first bind wins (contract item 4). Holding it, this daemon also owns, in this order:
//   1. the role's generation, taken under the lock (lib/residents-role.mjs);
//   2. a residents host: this home's `residents` records and `residents.turns.json`, restored as C3 restores any turns,
//      so an open turn a predecessor saved stays open and busy (P-1, contract item 9);
//   3. `residents.json`, the descriptor the residents' hooks read, pointing at this daemon;
//   4. a sender publishing that population under the home's publisher instance, `residents-<hash12>`.
// Any of 2-4 failing gives the role back, reported, and the next sweep tries again.
//
// EVERY RESIDENT EFFECT ENTERS THE ROLE (contract item 7): a turn event, a resident lifecycle stop and a publication
// each take an operation from `enter()`, or are refused `not-owner`, and ask the lock again at their effect. The
// daemon's own managed population stays on its own host and key, untouched by any of this (contract item 10).

import { AgentStateHost } from "./agent-state-host.mjs";
import { writeFileDurably } from "./durable-file.mjs";
import { descriptorFile, writeDescriptor } from "./instance-descriptor.mjs";
import { RESIDENTS } from "./residents-home.mjs";
import { ResidentsRole, notOwnerError } from "./residents-role.mjs";

/**
 * One agent's raw identity from the managed host and, while the role is held here, the residents host. PURE. Two
 * current lifetimes are a conflict, never resolved by picking; either side unknown is unknown.
 */
export function composeIdentity(managed, residents) {
  if (!residents) return managed;
  const both = Boolean(managed.current && residents.current);
  return { current: both ? null : managed.current ?? residents.current,
    conflict: managed.conflict || residents.conflict || both, unknown: managed.unknown || residents.unknown };
}

export class DaemonResidents {
  #role;
  #aifyHome;
  #url;
  #pid;
  #probe;
  #nowUs;
  #nowMs;
  #report;
  #makeSender = null;
  #host = null;
  #sender = null;
  #noted = null;
  #releasing = null;

  /**
   * @param {{aifyHome: string, url: string, pid: number, probe: Function, nowUs: () => number, nowMs?: () => number,
   *   report?: (line: string) => void}} parts
   */
  constructor({ aifyHome, url, pid, probe, nowUs, nowMs = Date.now, report = () => {} }) {
    this.#role = new ResidentsRole({ aifyHome });
    this.#aifyHome = aifyHome;
    this.#url = url;
    this.#pid = pid;
    this.#probe = probe;
    this.#nowUs = nowUs;
    this.#nowMs = nowMs;
    this.#report = report;
  }

  /** The residents host while the role is held here, else null. */
  get host() { return this.#role.holds() ? this.#host : null; }

  /**
   * How a publisher is made for the residents population: `({instance, generation, stateHost, admit}) => sender`. The
   * daemon supplies it, because the sender's registry, credentials and readers are the daemon's.
   */
  attachSender(makeSender) { this.#makeSender = makeSender; }

  /** One evaluation: try for the role while it is not held here, then publish while it is. */
  async tick() {
    if (this.#releasing) return;
    if (!this.#role.holds() && !(await this.acquire())) return;
    await this.#sender?.tick();
  }

  /** @returns {Promise<boolean>} whether this daemon holds the role, with its host, descriptor and sender, afterwards */
  async acquire() {
    if (this.#releasing) return false;
    if (this.#role.holds()) return true;
    this.#discard();
    const taken = await this.#role.acquire();
    if (!taken.held) { this.#note(`not held: ${taken.reason}`); return false; }
    try {
      const host = new AgentStateHost({ aifyHome: this.#aifyHome, instance: RESIDENTS, probe: this.#probe,
        nowUs: this.#nowUs, population: "residents" });
      for (const problem of host.boot().problems) this.#report(`residents: ${problem}`);
      const guard = () => { if (!this.#role.holds()) throw notOwnerError(); };
      writeDescriptor(descriptorFile(this.#aifyHome, RESIDENTS),
        { url: this.#url, instance: RESIDENTS, pid: this.#pid, startedAt: new Date(this.#nowMs()).toISOString() },
        { write: (file, text) => writeFileDurably(file, text, { guard }) });
      this.#host = host;
      this.#sender = this.#makeSender?.({ instance: this.#role.publisherInstance, generation: this.#role.generation,
        stateHost: host, admit: () => this.#role.enter() }) ?? null;
    } catch (error) {
      this.#discard();
      await this.#role.release({ waitMs: 0, reason: `boot-failed: ${error?.code || error?.message || "error"}` });
      this.#note(`not held: ${this.#role.report().reason}`);
      return false;
    }
    this.#note(`held, generation ${this.#role.generation}, publishing as ${this.#role.publisherInstance}`);
    return true;
  }

  /** Admit one resident operation against the residents host, or null: `not-owner`. */
  enter() {
    const op = this.#role.enter();
    if (!op) return null;
    if (!this.#host) { op.done(); return null; }
    return { host: this.#host, op };
  }

  /** One agent's identity across this daemon's hosts. The residents host answers only while the role is held here. */
  identity(agentId, managedHost) {
    const host = this.host;
    if (!host) return managedHost.rawIdentity(agentId);
    return composeIdentity(managedHost.rawIdentity(agentId, { answeredElsewhere: (record) => record.instance === RESIDENTS }),
      host.rawIdentity(agentId));
  }

  /** Re-judge the residents' records, when the role is held here. */
  refresh() { this.host?.refresh(); }

  report() { return this.#role.report(); }

  /** The ordered release (contract item 8), once: later calls share it. */
  release({ waitMs } = {}) {
    this.#releasing ??= this.#role.release(waitMs === undefined ? {} : { waitMs }).then((outcome) => {
      this.#discard();
      if (outcome.timedOut) this.#report(`residents role released after its wait; ${outcome.abandoned} operation(s) abandoned`);
      return outcome;
    });
    return this.#releasing;
  }

  #discard() {
    this.#sender?.stop();
    this.#sender = null;
    this.#host = null;
  }

  /** Report a change of role, once: a sweep that finds the same answer says nothing. */
  #note(line) {
    if (line === this.#noted) return;
    this.#noted = line;
    this.#report(`residents role ${line}`);
  }
}
