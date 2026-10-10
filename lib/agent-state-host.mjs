// One aify-env instance's view of its agents: lifetime records judged against the OS, each lifetime's turn kept on
// disk, and one word per agent derived from them (0.9 plan P0 C3, C4; G1 of the 2026-10-04 gap list).
//
// THE HOST COMPOSES, IT DECIDES NOTHING ITSELF. What a record means is lib/resident-lifetimes.mjs; whose turn an
// event may touch and in what order is lib/turn-events.mjs; what is restored after a restart is restoreTurns; the
// word is deriveAgentState. The one rule added here is C3's held gate: a verified lifetime whose turn this host never
// saw (adopted with nothing stored, or stored in a file that could not be read) is `unknown` until its next hook,
// never `idle`. A fresh screen sighting of work still decides, as C3's row 4 outranks the turn.
//
// EXPLICIT INPUTS: the aify home, the instance, the OS probe (lib/process-probe.mjs's shape) and a microsecond clock.
// Nothing here starts, stops or signals a process. Managed workers' lifetimes (G4), the hook route (G3) and the
// daemon wiring (G2) are later pieces.

import fs from "node:fs";
import path from "node:path";

import { deriveAgentState } from "./agent-state.mjs";
import { currentLifetimes, parseLifetimeRecord, verifyLifetime } from "./resident-lifetimes.mjs";
import { applyTurnEvent, restoreTurns, turnIsBusy } from "./turn-events.mjs";
import { readTurns, turnsFile, writeTurns } from "./turns-file.mjs";

const RECORD_NAME = /^(.+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export class AgentStateHost {
  #home;
  #instance;
  #probe;
  #nowUs;
  #turnsPath;
  /** lifetime -> pinned creation time, from the first `yes` (C4: later sightings must match it). */
  #pins = new Map();
  /** agentId -> currentLifetimes' entry for that agent. */
  #lifetimes = new Map();
  /** Agents whose record could not be read, and whether the residents folder itself could be. */
  #unreadableAgents = new Set();
  #listingFailed = false;
  /** Identity only from the last successful resident scan, never cached process or lifetime facts. */
  #residentIds = new Set();
  /** Every lifetime's turn record, keyed by lifetime (lifetimes are unique across agents). */
  #turns = {};
  /** Lifetimes whose turn this host knows: restored from a readable file, or touched by an applied event. */
  #known = new Set();
  #managed = new Map();
  #endFailure = null;

  /**
   * @param {{aifyHome: string, instance: string, probe: (pids: number[]) => Map<number, object>, nowUs: () => number}} io
   */
  constructor({ aifyHome, instance, probe, nowUs }) {
    if (typeof probe !== "function" || typeof nowUs !== "function") throw new TypeError("AgentStateHost needs a probe and a clock");
    this.#home = aifyHome;
    this.#instance = instance;
    this.#probe = probe;
    this.#nowUs = nowUs;
    this.#turnsPath = turnsFile(aifyHome, instance);
  }

  /**
   * Read the stored turns, judge every record, and keep each stored turn by its lifetime's verdict now (C3).
   * @returns {{problems: string[], ended: string[]}}
   */
  boot() {
    const stored = readTurns(this.#turnsPath);
    const problems = this.refresh().problems;
    if (stored.turns === null) {
      // Nothing restored, and nothing marked known: every verified lifetime reads its turn as unknown.
      problems.push(`turns: ${stored.problem}`);
      return { problems, ended: [] };
    }
    const verdicts = this.#verdictByLifetime();
    const { turns, ended } = restoreTurns(stored.turns, (lifetime) => verdicts.get(lifetime) ?? "unknown");
    this.#turns = turns;
    for (const lifetime of Object.keys(turns)) this.#known.add(lifetime);
    if (ended.length) writeTurns(this.#turnsPath, this.#turns);
    return { problems, ended };
  }

  /**
   * Judge every lifetime record against the OS, in one probe. A record proved `no` of this instance is removed (C4);
   * an `unknown` one is never removed. @returns {{problems: string[]}}
   */
  refresh() {
    const problems = [];
    const records = this.#readRecords(problems);
    if (!this.#listingFailed) this.#residentIds = new Set(records.map((record) => record.agentId));
    const answers = records.length ? this.#probe(records.map((record) => record.pid)) : new Map();
    const verdicts = records.map((record) => {
      const answer = answers.get(record.pid) ?? { alive: null, createdAtUs: null, commandLine: null };
      const judged = verifyLifetime(record, answer, this.#pins.get(record.lifetime) ?? null);
      if (judged.pin === null) this.#pins.delete(record.lifetime);
      else this.#pins.set(record.lifetime, judged.pin);
      if (judged.verified === "no" && record.instance === this.#instance) this.#remove(record, problems);
      return { record, verified: judged.verified };
    });
    this.#verdicts = verdicts;
    this.#selectLifetimes();
    return { problems };
  }

  /**
   * Apply one turn event to its agent's lifetime (C3 admission, then ordering), saved durably when it applies.
   * @param {{agentId: string, lifetime?: string, kind: string, firedAtUs: number}} event
   * @returns {{applied: boolean, reason: string, lifetime: string|undefined}}
   */
  applyEvent(event) {
    if (this.#endFailure) throw this.#endFailure;
    const result = applyTurnEvent(this.#turns, event, this.#lifetimes.get(String(event?.agentId ?? "")));
    if (result.applied) {
      writeTurns(this.#turnsPath, result.turns);
      this.#turns = result.turns;
      this.#known.add(result.lifetime);
    }
    return { applied: result.applied, reason: result.reason, lifetime: result.lifetime };
  }

  /**
   * The agent's word and what decided it. `given` carries the facts this host does not observe yet: definition, mode
   * and stoppedByOperator always; screen and backgroundShells until herdr forwarding (D10) supplies them.
   */
  current(agentId, given = {}) {
    const entry = this.#lifetimes.get(agentId);
    const current = entry?.current ?? null;
    const retained = current ? null : (entry?.unknown ?? [])[0] ?? null;
    const lifetime = current?.lifetime ?? retained?.lifetime ?? null;
    const turn = lifetime && Object.hasOwn(this.#turns, lifetime) ? this.#turns[lifetime] : null;
    const nowUs = this.#nowUs();
    const strict = turnIsBusy(turn ?? undefined, { nowUs, renewable: false });
    const process = this.#processFacts(agentId, entry, current, retained);
    // P-1 selects the no-age hold only from current verified process facts, never retained entry presence.
    const busy = turnIsBusy(turn ?? undefined, { nowUs, renewable: Boolean(current) && process.state === "running" && process.verified === "yes" });
    const facts = {
      stoppedByOperator: given.stoppedByOperator, definition: given.definition, mode: given.mode,
      process: process.state, verified: process.verified, startingInWindow: false, conflict: Boolean(entry?.conflict),
      busy, awaitingInput: turn?.awaitingInput === true,
      screen: given.screen ?? null, backgroundShells: given.backgroundShells ?? 0,
    };
    let { state, cause } = deriveAgentState(facts);
    // C3's held gate: a turn this host never saw cannot say `idle` or `shell`.
    if (current && !this.#known.has(current.lifetime) && cause === "at-prompt") ({ state, cause } = { state: "unknown", cause: "turn-unknown" });
    return {
      agentId, lifetime: current?.lifetime ?? null, state, stateCause: cause, busy,
      process: { state: process.state, verified: process.verified, pid: (current ?? retained)?.pid ?? null },
      turn: turn && {
        open: turn.open, startedAtUs: turn.startedAtUs, lastEventAtUs: turn.lastEventAtUs, awaitingInput: turn.awaitingInput,
        // Retain the wire name; verifiedRenewal now means verified-lifetime hold, not hook-age renewal.
        busyIf: { strict, verifiedRenewal: busy },
      },
    };
  }

  /** Refreshed effect identity, independent of the displayed state or Runner list. */
  rawIdentity(agentId) {
    this.refresh();
    const entry = this.#lifetimes.get(agentId);
    const foreign = this.#verdicts.some(({ record, verified }) => record.agentId === agentId && record.instance !== this.#instance && verified !== "no");
    const current = entry?.current ?? null;
    return { current: current ? { ...current, ...(this.#pins.has(current.lifetime) ? { createdAtUs: this.#pins.get(current.lifetime) } : {}) } : null,
      conflict: Boolean(entry?.conflict),
      unknown: this.#listingFailed || this.#unreadableAgents.has(agentId) || Boolean(entry?.unknown?.length) || foreign };
  }

  /** Refresh once, then return current() rows without exposing lifetime storage. */
  readAll(givenById = new Map(), missingGiven = {}) {
    const refreshed = this.refresh();
    const problems = [];
    if (this.#listingFailed) problems.push("resident-enumeration-failed");
    if (this.#unreadableAgents.size) problems.push("resident-record-unreadable");
    if (refreshed.problems.length && !problems.length) problems.push("resident-refresh-incomplete");
    const ids = [...new Set([...this.#lifetimes.keys(), ...this.#residentIds, ...this.#unreadableAgents, ...givenById.keys()])].sort();
    const agents = ids.map((id) => {
      const given = { ...missingGiven, ...givenById.get(id) };
      if (given.mode === undefined) {
        const sources = [...this.#verdicts, ...this.#managed.values()].filter(({ record }) => record.agentId === id);
        const modes = new Set(sources.map(({ record }) => this.#managed.has(record.lifetime) ? "managed" : "resident"));
        if (this.#listingFailed && this.#residentIds.has(id)) modes.add("resident");
        if (modes.size === 1) given.mode = [...modes][0];
      }
      return this.current(id, given);
    });
    return { agents, complete: problems.length === 0, problems };
  }

  #verdicts = [];

  #selectLifetimes() {
    this.#lifetimes = currentLifetimes([...this.#verdicts, ...this.#managed.values()], { instance: this.#instance });
  }

  /** Actual Runner child creation, not resident adoption or a synthetic turn event. */
  startManaged(record) {
    this.#managed.set(record.lifetime, { record, verified: "yes" });
    this.#selectLifetimes();
  }

  /** Invalidate admission first. Failed durability blocks later turn writes, never Runner cleanup. */
  endManaged(lifetime) {
    if (!this.#managed.delete(lifetime)) return { ended: false, problem: "" };
    this.#selectLifetimes();
    if (!Object.hasOwn(this.#turns, lifetime)) return { ended: true, problem: "" };
    if (this.#endFailure) return { ended: true, problem: "persistence-failed" };
    const turns = { ...this.#turns };
    delete turns[lifetime];
    try {
      writeTurns(this.#turnsPath, turns);
      this.#turns = turns;
      this.#known.delete(lifetime);
      return { ended: true, problem: "" };
    } catch (error) {
      this.#endFailure = error;
      return { ended: true, problem: error?.code || "persistence-failed" };
    }
  }

  #verdictByLifetime() {
    return new Map(this.#verdicts.map(({ record, verified }) => [record.lifetime, verified]));
  }

  #processFacts(agentId, entry, current, retained) {
    // A folder or record that could not be read says nothing: the agent may be running.
    if (this.#listingFailed || this.#unreadableAgents.has(agentId)) return { state: "unknown", verified: "unknown" };
    if (entry?.conflict || current) return { state: "running", verified: "yes" };
    if (retained) return { state: "running", verified: "unknown" };
    return { state: "none", verified: "no" };
  }

  #readRecords(problems) {
    const dir = path.join(this.#home, "residents");
    this.#listingFailed = false;
    this.#unreadableAgents = new Set();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      this.#listingFailed = true;
      problems.push(`residents: ${error?.code || error?.message || error}`);
      return [];
    }
    const records = [];
    for (const name of names) {
      const named = RECORD_NAME.exec(name);
      if (!named) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch (error) {
        if (error?.code === "ENOENT") continue;
        text = null;
      }
      const parsed = text === null ? { ok: false, problem: `${name}: unreadable` } : parseLifetimeRecord(text, name);
      if (parsed.ok) records.push(parsed.record);
      else { problems.push(parsed.problem); this.#unreadableAgents.add(named[1]); }
    }
    return records;
  }

  #remove(record, problems) {
    try {
      fs.rmSync(path.join(this.#home, "residents", `${record.agentId}.${record.lifetime}.json`), { force: true });
    } catch (error) {
      problems.push(`${record.agentId}.${record.lifetime}.json: not removed: ${error?.code || error?.message || error}`);
    }
  }
}
