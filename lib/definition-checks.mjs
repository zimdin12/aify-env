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
    else if (sync.published) published.push(`${name} has revision ${sync.published.revision}`);
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
  return passed(id, `${missing.length} agent(s) the services know on this host have no definition here: ${missing.join(", ")}`
    + ` (they run as before; \`aify-env agents import\` defines them)${unasked}`);
}
