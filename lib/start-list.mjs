// The start list as drawn, and the one search match both lists use (v0.7.7, TUI 1).
//
// THE OPERATOR'S EXAMPLE: "starting agent maybe should open something that has a search". `s` now
// opens this list IN PLACE OF the process table, typing filters it, and it says "N of M". The rows
// are the agents `startable-agents.mjs` offers; the ones it refused keep their grouped summary.
//
// ONE MATCH FOR BOTH LISTS. The process finder (`ConsoleSession.visible`) and this list call
// `matchesQuery`, so the two searches cannot drift apart.

import { paint } from "./paint.mjs";
import { clip } from "./text-width.mjs";

/** Does any of `texts` contain `query`, ignoring case and surrounding space? An empty query matches. */
export function matchesQuery(texts, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return true;
  return texts.map((text) => String(text ?? "")).join(" ").toLowerCase().includes(needle);
}

/** What a start-list row is searched on: what it shows. */
export function startRowTexts(agent) {
  return [agent?.name, agent?.id, agent?.status, agent?.runtime];
}

/** `… N above, N below`, or nothing when the whole list is on screen. */
export function offScreenNote(above, below, on) {
  const parts = [];
  if (above > 0) parts.push(`${above} above`);
  if (below > 0) parts.push(`${below} below`);
  return parts.length ? [`  ${paint(`… ${parts.join(", ")} — the window follows the selection`, ["dim"], on)}`] : [];
}

/**
 * The start list's lines.
 *
 * @param start  `ConsoleSession.startView()`: the filtered `agents`, the cursor `at`, the `query`,
 *   the unfiltered `total`, and `problem`, `skipped`, `asked`, `service`
 * @param window which slice of `agents` to draw, or null for all of it; set by the fitting pass
 */
export function startListLines(start, columns, on, window = null) {
  const rows = Array.isArray(start?.agents) ? start.agents : [];
  const at = Number.isFinite(start?.at) ? start.at : 0;
  const problem = String(start?.problem || "");
  const total = Number.isFinite(start?.total) ? start.total : rows.length;
  const lines = [`  ${paint("start an agent on this host", ["bold"], on)}`
    + (total ? `  ${paint(`${rows.length} of ${total}`, ["dim"], on)}` : "")];
  // THE SEARCH, ECHOED, with a block for a cursor so an empty query still reads as an open prompt.
  lines.push(`  ${paint("find", ["bold"], on)} ${paint(`${start?.query ?? ""}▌`, ["bold"], on)}`
    + (total && !rows.length ? paint("   no match", ["yellow"], on) : ""));
  // A PARTIAL ANSWER IS STILL DRAWN beside its warning: a list can be short AND explained.
  if (problem) lines.push(`  ${paint(problem, ["yellow"], on)}`);
  if (!rows.length) {
    if (problem || total) return [...lines, ...skippedLines(start, columns, on)];
    // UNANSWERED IS NOT EMPTY. `asked` is false until a reply arrives, so a slow or unreachable
    // service is never drawn as a host with nothing to start. The service is named only when the
    // answer named it: this is the host tier, which knows no service by name.
    lines.push(start?.asked
      ? `  ${paint("nothing to start on this host", ["dim"], on)}`
      : `  ${paint(start?.service ? `asking ${start.service}…` : "asking…", ["dim"], on)}`);
    return [...lines, ...skippedLines(start, columns, on)];
  }
  const from = window?.start ?? 0;
  for (const [offset, agent] of rows.slice(from, window?.end ?? rows.length).entries()) {
    const here = from + offset === at;
    // THE STATUS AND THE RUNTIME TRAVEL WITH THE NAME: "available" and "stopped" are different
    // decisions, and choosing between them from names alone is choosing blind.
    const detail = [agent.status, agent.runtime, agent.herdrSpace === false ? "no herdr space" : ""]
      .filter(Boolean).join(" · ");
    const row = clip(`${here ? "❯" : " "} ${agent.name || agent.id}${detail ? `  ${detail}` : ""}`, Math.max(10, columns - 6));
    // THE DOT IN THE STATUS'S OWN COLOUR, the dashboard's (agent-status-palette.mjs); selection is bold.
    const dot = agent.hue ? paint("●", [agent.hue], on) : " ";
    lines.push(`  ${dot} ${here ? paint(row, ["bold"], on) : paint(row, ["dim"], on)}`);
  }
  if (window) lines.push(...offScreenNote(from, rows.length - window.end, on));
  lines.push(...skippedLines(start, columns, on));
  return lines;
}

/**
 * What this host knows and did not offer, grouped by reason, drawn whether the list is full or empty:
 * "nothing to start" and "thirteen to start" raise the same question about the agents that are missing.
 */
function skippedLines(start, columns, on) {
  const groups = Array.isArray(start?.skipped) ? start.skipped.filter((g) => g && g.why && g.count > 0) : [];
  if (!groups.length) return [];
  const width = Math.max(10, columns - 4);
  return groups.map((group) => `  ${paint(clip(`  ${group.count} not offered — ${group.why}`, width), ["dim"], on)}`);
}
