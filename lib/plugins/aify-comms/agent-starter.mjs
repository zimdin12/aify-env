// Starting a known agent that has no running worker, on this host's behalf.
//
// THE OPERATOR'S ASK, 2026-09-08: "start available agent (mb get available via aify-comms plugin
// that aify-env has?)" -- and their decision when asked what it should mean: it RE-STARTS a known
// agent, rather than spawning a new one.
//
// THIS TIER ASKS; IT DOES NOT DECIDE. The service owns spawning: it composes the launch, routes the
// request to the agent's own environment, and hands this host the work through the claim loop it
// already runs. So a "start" here is one POST, and the worker arrives by the ordinary path -- the
// same one a dashboard Restart uses. Implementing a second way to bring an agent up is precisely
// the collision the environment tier exists to end.
//
// ── THE BODY FIELD IS OMITTED ON PURPOSE, AND THAT IS THE MOST IMPORTANT LINE IN THIS FILE.
//
// `/sessions/:id/control` stores `body` as the spawn request's `initial_message`, and the service
// turns a non-empty one into a real `type=request` MESSAGE plus a dispatch run addressed to the
// agent that just came up. A polite receipt therefore arrives at a freshly-started agent as an
// instruction owing a reply -- and the obvious reply is to restart itself.
//
// MEASURED ON THIS FLEET: all 21 self-issued spawn requests were preceded, 45 to 75 seconds
// earlier, by exactly one dashboard `Restart <agent>` message of type=request. That is the whole of
// the operator's "agents exited even though I never stopped them". A control has no brief, and
// sending one was the mistake. This sends none.
//
// ── AND THE LIST IS RE-CHECKED AT THE MOMENT OF ACTING.
//
// A menu is built from a snapshot and confirmed by a human some seconds later, during which the
// agent may have come up by a send, a dispatch, or the service's own reconcile. Starting anyway is
// how an agent gets two workers. So `start` reads the roster again and asks the same pure rule, and
// then asks the session listing a second, independent question -- a live session refuses even if
// the roster still says otherwise. This is the lesson the console's stop confirmation already
// learned the hard way, where a target resolved at menu-open time was no longer the row on screen.

import { restartTargetFor, startabilityOf, startableAgents } from "../../startable-agents.mjs";

/**
 * The agents this host can offer to start, and the one call that starts one.
 *
 * EVERY METHOD RESOLVES RATHER THAN THROWS. Both are reached from a keyboard handler and from an
 * HTTP route, and a rejected promise in either place is a screen that dies or a 500 that says
 * nothing. The failure travels as a `problem` string the view can put in front of the operator.
 */
export class AgentStarter {
  #api;
  #machineId;

  /**
   * @param {object} deps
   * @param {object} deps.api        a `CommsApi`, or anything with the same three calls
   * @param {string} deps.machineId  this environment's own machine id, used to scope the list
   */
  constructor({ api, machineId = "" } = {}) {
    if (!api) throw new TypeError("AgentStarter needs an api");
    this.#api = api;
    this.#machineId = String(machineId || "");
  }

  /**
   * Which known agents on this host have no running worker.
   *
   * @returns {Promise<{agents: Array<object>, problem: string}>}
   */
  async list() {
    // AN UNKNOWN MACHINE IDENTITY IS REPORTED, not silently answered with an empty list. Those two
    // look identical on screen -- "no agents to start" -- and one of them is a host that cannot say
    // who it is, which is a different problem with a different fix.
    if (!this.#machineId) {
      return { agents: [], problem: "this environment cannot say which machine it is, so it cannot scope the list" };
    }
    let roster;
    try {
      roster = await this.#api.agents();
    } catch (error) {
      return { agents: [], problem: `aify-comms did not answer: ${error?.message || error}` };
    }
    return { agents: startableAgents(roster, { machineId: this.#machineId }), problem: "" };
  }

  /**
   * Start one agent, or say why not.
   *
   * @param {string} agentId
   * @returns {Promise<{started: boolean, agentId: string, sessionId: string, problem: string}>}
   */
  async start(agentId) {
    const id = String(agentId || "").trim();
    const no = (problem, sessionId = "") => ({ started: false, agentId: id, sessionId, problem });
    if (!id) return no("no agent was named");
    if (!this.#machineId) return no("this environment cannot say which machine it is");

    // FIRST QUESTION, ASKED AGAIN. The caller chose from a snapshot; this is the fresh reading, and
    // it is allowed to disagree.
    let roster;
    try {
      roster = await this.#api.agents();
    } catch (error) {
      return no(`aify-comms did not answer: ${error?.message || error}`);
    }
    const agent = roster?.agents?.[id];
    if (!agent) return no(`aify-comms does not know an agent called "${id}"`);
    const verdict = startabilityOf(agent, { machineId: this.#machineId });
    if (!verdict.startable) return no(`cannot start ${id}: ${verdict.reason}`);

    // SECOND QUESTION, OF A DIFFERENT SOURCE. The roster's status is derived and cached; the session
    // listing is the row a restart would act on. Asking both is what makes "no live worker" evidence
    // rather than an inference from one cache.
    let listing;
    try {
      listing = await this.#api.sessionsFor(id);
    } catch (error) {
      return no(`aify-comms did not list sessions for ${id}: ${error?.message || error}`);
    }
    const target = restartTargetFor(listing);
    if (!target.sessionId) return no(`cannot start ${id}: ${target.refusal}`);

    try {
      const answer = await this.#api.controlSession(target.sessionId, "restart");
      // AN EXPLICIT `ok: false` IS A REFUSAL, and the route can answer one with a 200. Reading only
      // the HTTP status would report a refused restart as a start that happened, and the operator
      // would wait for a worker that was never coming.
      if (answer && answer.ok === false) {
        return no(`aify-comms refused the restart: ${answer.error || "no reason given"}`, target.sessionId);
      }
      return { started: true, agentId: id, sessionId: target.sessionId, problem: "" };
    } catch (error) {
      return no(`the restart was not accepted: ${error?.message || error}`, target.sessionId);
    }
  }
}
