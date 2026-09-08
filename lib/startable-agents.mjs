// Which known agents this host could START, and which session a start would act on.
//
// THE OPERATOR ASKED FOR IT IN THESE WORDS, 2026-09-08: "spawn, start available agent (mb get
// available via aify-comms plugin that aify-env has?)". Asked what that should mean, they decided:
// it RE-STARTS a known agent that has no running worker, rather than spawning a new one. The web
// dashboard already spawns well, and duplicating that here would need a form layer for runtime,
// role, cwd and model before it could ask anything useful.
//
// PURE, so every rule below is a function call rather than a comment. No fetch, no plugin, no
// daemon: the roster and the session listing arrive as data, exactly as the service returns them.
//
// ── THE ALLOWLIST IS THE WHOLE SAFETY ARGUMENT, and it is not the obvious rule.
//
// Starting an agent that already has a worker gives it two, and this project has measured what that
// costs: on 2026-09-03 the service reconciled live terminals as dead ghosts and asked for
// replacements, and the host dutifully started them beside the ones still running. So the rule
// cannot be "anything that does not look live" -- a status this file has never heard of satisfies
// that and gets offered. It is a list of statuses that MEAN no worker, and every other status is
// refused, including ones invented after this was written.
//
// AND "HAS NO WORKER" IS NOT SUFFICIENT EITHER, which is the part I would have got wrong from the
// word alone. `starting` has no worker yet and must NOT be offered: the contract says so in as many
// words -- "Do NOT restart or re-send - a restart kills the boot in flight". `misconfigured` has no
// worker and can never get one until a human edits its config, so offering it is a row that always
// fails. Both are absent from the allowlist for reasons that are about MEANING, not liveness.
//
// THE VOCABULARY IS AIFY-COMMS' OWN -- `service/contracts/vocabulary.json`, `agentStatuses` -- and
// each meaning is quoted beside the entry it decides, because the meaning is what the rule turns on
// rather than the word. An agreement test in the aify-comms bridge suite drives both sides, so a
// status added there whose meaning changes this answer reddens a test instead of sitting here
// silently wrong.

/**
 * Statuses that mean "no worker is running, and one can be started", with the contract's own words.
 *
 * A MAP RATHER THAN A LIST, so the reason travels with the entry. A view that can only say "3
 * agents" is a view an operator has to take on trust; one that can say WHY a row is offered is one
 * they can disagree with.
 */
export const STARTABLE_STATUSES = Object.freeze({
  available: "managed and cold-startable, no worker",
  stopped: "operator-disabled, no worker",
  offline: "no current wake path",
});

/**
 * Every other status in the vocabulary, and why a start is refused for it.
 *
 * WRITTEN OUT RATHER THAN IMPLIED BY ABSENCE. A reader checking whether this file judges the whole
 * vocabulary can only do that if the whole vocabulary is here; "not in the allowlist" tells them
 * nothing about whether it was considered. The agreement test walks both maps against the contract,
 * so a status in neither is a red test rather than a silent refusal.
 */
export const NOT_STARTABLE_STATUSES = Object.freeze({
  working: "a live worker is mid-turn",
  online: "a live worker is running",
  blocked: "a live worker is waiting on the operator",
  starting: "a claimed spawn is already coming up — restarting kills the boot in flight",
  misconfigured: "it can never start until a human fixes its config",
});

/**
 * Session statuses that mean a worker is live, mirroring `service/api_core/liveness.py`.
 *
 * READ AT THE MOMENT OF ACTING, not at the moment of listing. The roster this view was built from
 * is up to a refresh interval old, and the thing it decides is whether to start a second worker for
 * an agent -- so the freshest evidence available gets to refuse. This is the same rule the pane's
 * confirmation follows after a stop retargeted the wrong agent: resolve again, at the act.
 */
export const LIVE_SESSION_STATUSES = Object.freeze([
  "starting", "running", "recovering", "restarting", "cli-takeover",
]);

const lower = (value) => String(value ?? "").trim().toLowerCase();

/**
 * Whether this host may offer to start this agent, and the reason either way.
 *
 * @param {object} agent one entry from `GET /api/v1/agents`, plus its id
 * @param {{machineId?: string}} host this environment's own machine id
 * @returns {{startable: boolean, reason: string}}
 */
export function startabilityOf(agent, { machineId = "" } = {}) {
  if (!agent || typeof agent !== "object") return { startable: false, reason: "no agent record" };

  // MANAGED ONLY, and this is a refusal rather than a filter for tidiness. A resident session lives
  // in a terminal the operator launched; the service's own restart path says a session-restart on a
  // live resident would fork a managed twin, and refuses it. Offering one here would be a row that
  // always fails, or -- worse -- one that succeeds and leaves the operator with two.
  const mode = lower(agent.sessionMode ?? agent.session_mode);
  if (mode !== "managed") {
    return { startable: false, reason: mode ? `${mode} sessions are the operator's to launch` : "no session mode" };
  }

  // THIS HOST'S AGENTS ONLY. A restart is routed by the service to the agent's OWN environment, so
  // starting one bound elsewhere would bring up a worker on a machine the operator is not looking
  // at, from a menu on the machine they are. Scoping by machine id is what makes the list mean
  // "things I can watch happen here".
  //
  // AN UNKNOWN HOST IDENTITY DOES NOT WIDEN THE LIST. If this environment cannot say which machine
  // it is, every agent would match an empty comparison and the menu would offer the whole fleet --
  // a guard that passes when its input is missing is decoration.
  const mine = lower(machineId);
  const theirs = lower(agent.machineId ?? agent.machine_id);
  if (!mine) return { startable: false, reason: "this environment cannot say which machine it is" };
  if (theirs !== mine) return { startable: false, reason: `runs on ${theirs || "an unnamed machine"}` };

  const status = lower(agent.status);
  const why = STARTABLE_STATUSES[status];
  if (why) return { startable: true, reason: why };
  // FAILS CLOSED ON A STATUS NOBODY HAS JUDGED. The named refusals below are for the reader; the
  // answer for anything else is the same, and is the safe one.
  return { startable: false, reason: NOT_STARTABLE_STATUSES[status] || `status "${status || "unknown"}" is not one this host judges` };
}

//: Offered first, because the operator's own word for what they wanted was "available". The rest
//: keep a stable order so the list does not reshuffle under an arrow key between refreshes.
const STATUS_ORDER = Object.freeze(["available", "stopped", "offline"]);

/**
 * The agents this host can offer to start, in the order a menu shows them.
 *
 * @param {object} roster the `GET /api/v1/agents` body, `{agents: {id: record}}`
 * @param {{machineId?: string}} host
 * @returns {Array<{id: string, name: string, status: string, runtime: string, role: string, reason: string}>}
 */
export function startableAgents(roster, { machineId = "" } = {}) {
  const table = roster && typeof roster === "object" ? roster.agents : null;
  if (!table || typeof table !== "object") return [];
  const rows = [];
  for (const [id, agent] of Object.entries(table)) {
    if (!id) continue;
    const verdict = startabilityOf(agent, { machineId });
    if (!verdict.startable) continue;
    rows.push({
      id,
      name: String(agent.name || id),
      status: lower(agent.status),
      runtime: String(agent.runtime || ""),
      role: String(agent.role || ""),
      reason: verdict.reason,
    });
  }
  rows.sort((a, b) => {
    const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    return rank !== 0 ? rank : a.id.localeCompare(b.id);
  });
  return rows;
}

/**
 * Which session a start acts on, or why it must not happen.
 *
 * TWO REFUSALS, and each is a real state rather than a defensive branch.
 *
 * A LIVE SESSION MEANS THE ROSTER WAS STALE. The list was built from a snapshot; between building it
 * and the operator confirming, the agent may have come up -- by a send, by a dispatch, by the
 * service's own reconcile. Starting anyway is how one agent ends up with two workers, so the
 * freshest reading wins and this refuses.
 *
 * NO SESSION AT ALL IS NOT A FAILURE, it is an agent that has never run here. There is nothing to
 * restart, and the remedy is the one the service's own tool names: send it a message, and a managed
 * agent cold-starts a worker on the send. Saying that is more use than "could not start".
 *
 * @param {object|Array} listing the `GET /api/v1/sessions?agentId=` body, or its `sessions` array
 * @returns {{sessionId: string, refusal: string}}
 */
export function restartTargetFor(listing) {
  const sessions = Array.isArray(listing) ? listing : (Array.isArray(listing?.sessions) ? listing.sessions : null);
  if (!sessions) return { sessionId: "", refusal: "the service did not return a session list" };

  const live = new Set(LIVE_SESSION_STATUSES);
  const alive = sessions.find((session) => live.has(lower(session?.status)));
  if (alive) return { sessionId: "", refusal: `it already has a ${lower(alive.status)} session — nothing to start` };

  // THE MOST RECENTLY SEEN, CHOSEN HERE rather than taken from the order the service happened to
  // return. That endpoint does sort live-first then `last_seen DESC` today, and relying on it would
  // make this answer depend on a detail of somebody else's SELECT: a page ordered any other way
  // would silently restart the OLDEST backing an agent ever had.
  let best = null;
  for (const session of sessions) {
    if (!session?.id) continue;
    if (!best || String(session.lastSeen || "") > String(best.lastSeen || "")) best = session;
  }
  if (!best) return { sessionId: "", refusal: "it has no session to restart — send it a message and a managed agent cold-starts one" };
  return { sessionId: String(best.id), refusal: "" };
}
