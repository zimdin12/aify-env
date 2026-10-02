// One doctor row for what every running service plugin says it could not do.
//
// THE HOST NAMES NO SERVICE. A plugin that has something to say puts sentences in `state.problems`;
// this row repeats them under the plugin's own name. A plugin whose state has no `problems` key says
// nothing here. When no running plugin reports problems at all there is no row: nothing is being asked,
// and a row that passed would be a green on no evidence while one left unanswered would sit amber on
// every host that loads only plugins without problems to tell.

import { failed, passed, unanswered } from "./health.mjs";

/**
 * @param {{answered?: boolean, plugins?: Array<{name: string, state: object}>|null}} input  from the daemon's `/health`
 * @returns {object|null} the row, or null when no running plugin reports problems
 */
export function pluginProblemsCheck({ answered = false, plugins = null } = {}) {
  const id = "plugin-problems";
  if (!answered) return unanswered(id, "no aify-env answered, so what its plugins could not do is unknown");
  if (!Array.isArray(plugins)) return unanswered(id, "this aify-env does not report its plugins, so what they could not do is unknown");
  const reporting = plugins.filter((plugin) => Array.isArray(plugin?.state?.problems));
  if (!reporting.length) return null;
  const lines = reporting.flatMap((plugin) => plugin.state.problems.map((problem) => `${plugin.name}: ${problem}`));
  if (lines.length) return failed(id, lines.join("; "), "each line says what to change; the plugin tries again on its own");
  return passed(id, `no problems reported by ${reporting.map((plugin) => plugin.name).join(", ")}`);
}
