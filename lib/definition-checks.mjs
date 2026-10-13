// The doctor's two questions about agent definitions (P0 C10, C11, D12). PURE: the daemon's own answers
// in, a check out. Two rows, because they are two questions with different remedies.
//
// `definitions`: are this host's definitions reaching each service? Read from each plugin's own sync
// state on /health, so it reports what the daemon did rather than what a second process could reach.
//
// `undefined-agents`: which agents the services know on this host have no definition here? Reported,
// and PASSED: an undefined agent runs exactly as it did before definitions existed. The row names them
// and the command that defines them, which is all a migration needs from a doctor.

import { failed, passed, unanswered } from "./health.mjs";
import { workspaceWithinRoots } from "./workspace-roots.mjs";

/**
 * @param {object} input
 * @param {boolean} input.answered  whether an aify-env answered at all
 * @param {Array<{name: string, state?: object}>|null} input.plugins  `/health`'s plugin reports
 */
export function definitionsCheck({ answered = false, plugins = null } = {}) {
  const id = "definitions";
  if (!answered) return unanswered(id, "no aify-env answered, so whether its definitions reach the services is unknown");
  if (!Array.isArray(plugins)) return unanswered(id, "this aify-env does not report its plugins, so whether it publishes definitions is unknown");
  const syncing = plugins.filter((plugin) => plugin?.state?.definitions && typeof plugin.state.definitions === "object");
  if (!syncing.length) {
    return unanswered(id, "no service plugin here publishes definitions (an aify-env older than them, or none running)");
  }
  const problems = [];
  const published = [];
  for (const { name, state: { definitions: sync } } of syncing) {
    if (sync.accepted === false) problems.push(`${name} does not accept definitions: it predates them`);
    else if (sync.lastPushError) problems.push(`${name}: not published (${sync.lastPushError})`);
    else if (sync.lastRequestError) problems.push(`${name}: change requests not applied (${sync.lastRequestError})`);
    else if (sync.refused?.length) {
      problems.push(`${name} refused ${sync.refused.map(({ id, reason }) => `${id} (${reason})`).join("; ")}`);
    } else if (sync.published) published.push(`${name} has revision ${sync.published.revision}`);
    else problems.push(`${name}: nothing published yet`);
  }
  if (problems.length) {
    return failed(id, problems.join("; "),
      "upgrade a service that predates definitions; otherwise see the aify-env log. `aify-env agents list` works meanwhile");
  }
  return passed(id, `this host's definitions are published: ${published.join(", ")}`);
}

/**
 * @param {{ok?: boolean, status?: number, body?: object}|null} answer  the daemon's `/agents/importable`
 */
export function undefinedAgentsCheck(answer) {
  const id = "undefined-agents";
  if (!answer?.ok) return unanswered(id, "no aify-env answered, so which agents lack a definition is unknown");
  const body = answer.body;
  if (answer.status === 404) return unanswered(id, "this aify-env predates definitions, so which agents lack one is unknown");
  if (!Array.isArray(body?.services) || !Array.isArray(body?.defined)) {
    return unanswered(id, `which agents lack a definition is unknown: ${body?.definedProblem || body?.problem || `HTTP ${answer.status}`}`);
  }
  const silent = body.services.filter((service) => service.problem).map((service) => `${service.service} (${service.problem})`);
  const defined = new Set(body.defined.map((agentId) => String(agentId).toLowerCase()));
  const missing = [...new Set(body.services.flatMap((service) => (service.agents ?? []).map((record) => record.id)))]
    .filter((agentId) => !defined.has(String(agentId).toLowerCase())).sort();
  const unasked = silent.length ? `; not asked: ${silent.join(", ")}` : "";
  if (!missing.length) {
    return silent.length && !body.services.some((service) => !service.problem)
      ? unanswered(id, `no service answered${unasked}`)
      : passed(id, `every agent the services know on this host is defined here${unasked}`);
  }
  const withdrawn = new Set(body.services.flatMap((service) => (service.agents ?? [])
    .filter((record) => record.withdrawn).map((record) => record.id)));
  const never = missing.filter((agentId) => !withdrawn.has(agentId));
  const gone = missing.filter((agentId) => withdrawn.has(agentId));
  const parts = [
    never.length && `${never.length} agent(s) the services know on this host have no definition here: ${never.join(", ")}`
      + " (they run as before; `aify-env agents import` defines them)",
    gone.length && `${gone.length} withdrawn here, so not started: ${gone.join(", ")}`
      + " (`aify-env agents import` defines them again)",
  ].filter(Boolean);
  return passed(id, `${parts.join("; ")}${unasked}`);
}

//: What to do about an agent outside the roots. This host runs work only below the folder it was started in.
const OUTSIDE_ROOTS_FIX = "stop aify-env and start it again from a folder that contains them (C:\\ covers this whole machine on Windows)";

/**
 * The managed agents defined here that this host will refuse to start: their workspace is outside the folders it was
 * started in. Resident agents are started by hand, so where they work is not this host's to bound. PURE.
 * @returns {Array<{id: string, workspace: string}>}
 */
export function definitionsOutsideRoots(definitions = [], roots = [], { windows = false } = {}) {
  return (definitions ?? [])
    .filter((reading) => reading?.agent?.mode === "managed" && !workspaceWithinRoots(reading.agent.workspace, roots, { windows }))
    .map((reading) => ({ id: reading.id, workspace: reading.agent.workspace }));
}

/** The one sentence the startup warning and the doctor both say, or "" when every managed agent can start. PURE. */
function outsideRootsSentence(outside, roots) {
  if (!outside?.length) return "";
  const named = outside.map(({ id, workspace }) => `${id} (${workspace})`).join(", ");
  return `${outside.length} managed agent(s) cannot be started by this aify-env, whose work stays under `
    + `${roots.join(", ")}: ${named}`;
}

/**
 * `agents-outside-roots`: the doctor's row for the above. `roots` comes from the daemon's /health (what the RUNNING
 * process was started in), `listed` from this host's definition store.
 */
export function agentsOutsideRootsCheck({ answered = false, roots = null, listed = null, windows = false } = {}) {
  const id = "agents-outside-roots";
  if (!answered) return unanswered(id, "no aify-env answered, so which folders it will start agents in is unknown");
  if (!Array.isArray(roots) || !roots.length) {
    return unanswered(id, "this aify-env does not report the folders it was started in (one older than that report)");
  }
  if (!Array.isArray(listed?.definitions)) return unanswered(id, "this host's agent definitions could not be read");
  const outside = definitionsOutsideRoots(listed.definitions, roots, { windows });
  // A PARTIAL LISTING CANNOT SAY "EVERY" (0.9.2 review): an entry that could not be read, an unsettled conflict or a
  // failed enumeration may be exactly the agent outside the roots. What was found still fails.
  const unread = listed.unreadable?.length || listed.conflict || listed.enumerationFailed;
  if (!outside.length && unread) {
    return unanswered(id, "this host's agent definitions were only partly read (unreadable entries, a conflict, or a "
      + "failed listing), so whether every managed agent can start is unknown");
  }
  if (!outside.length) return passed(id, `every managed agent defined here works under ${roots.join(", ")}`);
  return failed(id, outsideRootsSentence(outside, roots), OUTSIDE_ROOTS_FIX);
}

/** The startup warning, or "" when every managed agent can start. PURE. */
export function outsideRootsWarning(definitions, roots, { windows = false } = {}) {
  const sentence = outsideRootsSentence(definitionsOutsideRoots(definitions, roots, { windows }), roots);
  return sentence ? `${sentence}. To start them, ${OUTSIDE_ROOTS_FIX}.` : "";
}
