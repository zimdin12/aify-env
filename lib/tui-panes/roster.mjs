// The view's ROSTER pane (0.9.7): the agents this environment defines that are not running.
//
// THE OPERATOR'S ASK, 2026-10-28: "stopped agents in their own pane", the agents table staying running-only. On that
// day /agents/state named 27 agents and the table showed the 9 with a process; the other 18 were on screen only
// inside `s`, and only the startable ones.
//
// NOT RUNNING IS THE ENVIRONMENT'S WORD: a record with no lifetime. Not "missing from the process list": a resident
// another host runs has a lifetime and no row here, and listing it as stopped would be this pane inventing a state.
//
// IT GIVES WAY FIRST. Compact (the fitting pass, or collapsed with `c` then `r`) it is one line of counts, so on a
// short terminal it costs the running agents nothing.

import { dashboardWord } from "../agent-status-palette.mjs";
import { paint } from "../paint.mjs";
import { heading, table } from "../tui-parts.mjs";
import { statusWord } from "./agent-columns.mjs";

/** The records with no lifetime, by name. */
function notRunning(snapshot) {
  return Object.values(snapshot.agentRecords ?? {})
    .filter((record) => record?.lifetime === null)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** "15 stopped · 3 available": how many in each word, most first. */
function counts(records) {
  const byWord = new Map();
  for (const record of records) {
    const word = dashboardWord(record.state);
    byWord.set(word, (byWord.get(word) ?? 0) + 1);
  }
  return [...byWord].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word, n]) => `${n} ${word}`).join(" · ");
}

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, ...}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, compact } = ctx;
  const records = notRunning(snapshot);
  if (!records.length) return [];
  const note = `${records.length} not running · ${counts(records)}`;
  if (compact) return [heading("ROSTER", note, wide, on)];
  return ["", heading("ROSTER", note, wide, on), ...table(
    ["agent", "status"],
    records.map((record) => [paint(record.agentId, ["bold"], on), statusWord(record, snapshot.nowMs, on)]),
    wide, on,
  )];
}
