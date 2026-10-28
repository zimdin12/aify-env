// What a managed worker's Herdr pane says: aify-env's word for its agent (0.9.9, Herdr status sync phase 1).
//
// THE DOT FOLLOWS THE WORD THE DASHBOARD SHOWS. The word is read the way the agent-state sender reads it
// (readAgentStates over the same observation), so a pane and the dashboard cannot disagree for longer than one read.
// Herdr knows four states; the word travels beside it as the message, so `shell` reads idle("shell").
//
// ONE WRITER. Every `pane report-agent` aify-env makes goes through here, the claim a new pane gets included, so each
// pane has one seq clock (microseconds since the epoch, the clock aify-wrapper's hooks report on; Herdr keeps the
// highest seq) and it never goes backwards.
//
// NEVER BLOCKS THE DAEMON. The claim is synchronous because it is part of opening a pane, which already is: the pane
// file is named to the launcher only once Herdr has accepted it. Every later report is asynchronous, at most one in
// flight per pane, and a report asked for meanwhile replaces the one waiting: the latest word wins and a slow Herdr
// queues nothing.
//
// NO PATH BACK IN. This reads the word and writes Herdr; nothing here is read by the word. A Herdr-sourced screen
// (D10, not built) must count only Herdr's own detection, never a report made under HERDR_AGENT_SOURCE.

import { readAgentStates } from "./agent-state-read.mjs";
import { REPORT_EVERY_MS } from "./agent-state-sender.mjs";

/** The source aify-wrapper's hooks report under too. Herdr refuses a state report on a claimed pane from any other. */
export const HERDR_AGENT_SOURCE = "herdr:aify";
/** Herdr's answer for a pane that no longer exists: nothing more is reported to it. */
const PANE_NOT_FOUND = "pane_not_found";

/** Herdr's state for each word that has one of its own; every other word is Herdr's `unknown`. */
const PANE_STATES = Object.freeze({
  idle: "idle", working: "working", blocked: "blocked",
  shell: "idle",
  // A boot in flight is work, not a fault: `unknown` reads as one on a dot.
  starting: "working",
  misconfigured: "blocked",
});

/** What a pane is told for one of aify-env's words: Herdr's state, and the word itself as the message. */
export function paneReportFor(word) {
  const said = typeof word === "string" && word ? word : "unknown";
  return { state: Object.hasOwn(PANE_STATES, said) ? PANE_STATES[said] : "unknown", message: said };
}

export class HerdrPaneReporter {
  #call;
  #callAsync;
  #observation;
  #read;
  #nowUs;
  #reassertUs;
  #log;
  /** paneId -> what this reporter holds for that pane, while it is open. */
  #panes = new Map();
  #reading = null;
  #again = null;

  /**
   * @param call        a synchronous Herdr call (argv) -> answer, used for the claim alone
   * @param callAsync   an asynchronous one (argv) -> Promise<answer>, used for every later report
   * @param observation what readAgentStates reads: the managed population's host, definitions, lifecycle, screens
   * @param reassertMs  a word unchanged for this long is said again, so a report made by anyone else does not stand
   */
  constructor({ call, callAsync, observation = null, read = readAgentStates, nowUs = () => Date.now() * 1000,
    reassertMs = REPORT_EVERY_MS, log = () => {} }) {
    this.#call = call;
    this.#callAsync = callAsync;
    this.#observation = observation;
    this.#read = read;
    this.#nowUs = nowUs;
    this.#reassertUs = reassertMs * 1000;
    this.#log = log;
  }

  /**
   * Claim a pane just opened: report it idle, synchronously, and THROW when Herdr refuses, so the opener names no
   * pane to the launcher. A pane opened for an agent is then told that agent's word from the next read on.
   */
  claim(paneId, { agentId = null, agent }) {
    const pane = { agentId, agent, seq: 0, wanted: null, sending: false, next: null, failure: "" };
    this.#call(this.#argv(paneId, pane, { state: "idle", message: "" }));
    if (!agentId) return;
    this.#panes.set(paneId, pane);
    void this.tick();
  }

  /** Report nothing more to this pane: it is closing. A report in flight lands or fails; none follows it. */
  forget(paneId) {
    this.#panes.delete(paneId);
  }

  /** Read the words and report each pane whose word changed. One read in flight, and one more after it. */
  tick() {
    if (!this.#panes.size || !this.#observation) return Promise.resolve();
    if (this.#reading) {
      this.#again ??= this.#reading.catch(() => {}).then(() => { this.#again = null; return this.tick(); });
      return this.#again;
    }
    this.#reading = this.#evaluate().finally(() => { this.#reading = null; });
    return this.#reading;
  }

  async #evaluate() {
    let read;
    try { read = await this.#read(this.#observation); }
    catch (error) { this.#log(`herdr: no words to report (${error?.message || error})`); return; }
    // AN INCOMPLETE READ SAYS NOTHING, as the publisher withholds it from the dashboard: each dot keeps its last word.
    if (read?.status !== 200 || read.body?.complete !== true) return;
    const words = new Map(read.body.agents.map((row) => [row.agentId, row.state]));
    const now = this.#nowUs();
    for (const [paneId, pane] of this.#panes) {
      const report = paneReportFor(words.get(pane.agentId));
      const said = pane.wanted;
      if (said && said.state === report.state && said.message === report.message && now - said.atUs < this.#reassertUs) continue;
      pane.wanted = { ...report, atUs: now };
      this.#enqueue(paneId, pane, this.#argv(paneId, pane, report));
    }
  }

  /** The report's argv, stamped now on this pane's clock: never below a seq it already used. */
  #argv(paneId, pane, { state, message }) {
    pane.seq = Math.max(this.#nowUs(), pane.seq + 1);
    return ["pane", "report-agent", paneId, "--source", HERDR_AGENT_SOURCE, "--agent", pane.agent, "--state", state,
      ...(message ? ["--message", message] : []), "--seq", String(pane.seq)];
  }

  #enqueue(paneId, pane, argv) {
    if (pane.sending) { pane.next = argv; return; }
    pane.sending = true;
    this.#callAsync(argv).then(() => { pane.failure = ""; }, (error) => {
      if (error?.code === PANE_NOT_FOUND) { if (this.#panes.get(paneId) === pane) this.forget(paneId); return; }
      // Said again at the next read, and reported once per distinct failure rather than once per tick.
      pane.wanted = null;
      const failure = String(error?.code || error?.message || error);
      if (failure !== pane.failure) this.#log(`herdr: ${paneId} not told its word (${failure})`);
      pane.failure = failure;
    }).finally(() => {
      pane.sending = false;
      const next = pane.next;
      pane.next = null;
      if (next && this.#panes.get(paneId) === pane) this.#enqueue(paneId, pane, next);
    });
  }
}
