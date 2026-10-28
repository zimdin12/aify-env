// The view's DETAIL pane (0.9.9, the operator's TUI upgrade, item 4): the selected agent in full, under the table.
//
// WHAT A ROW CANNOT HOLD. The table clips the title to whatever width is left and shows only the columns chosen; this
// shows the whole title (wrapped, never clipped), the role and cwd from its record, the harness, model and effort from
// its definition (DefinitionStore.readOnlySummary, read without a lock), and how long it has been in its state.
//
// ONLY WITH A KEYBOARD. With none there is no selected agent, so a piped render draws nothing here.
//
// A FIELD NOBODY REPORTED SAYS SO (`—`), rather than leaving a gap that reads as an empty value.

import { dashboardWord } from "../agent-status-palette.mjs";
import { paint } from "../paint.mjs";
import { wrapToWidth } from "../text-width.mjs";
import { heading } from "../tui-parts.mjs";
import { stateAge } from "./agent-columns.mjs";

//: The label column's width: the longest label, so every value starts in one column.
const LABELS = ["title", "role", "cwd", "harness", "model", "effort", "state"];
const LABEL_WIDTH = Math.max(...LABELS.map((label) => label.length));

/** The agent the keys are on, or null with no keyboard, no rows, or the start list in the table's place. */
function selectedRow(ctx) {
  const rows = ctx.view?.rows;
  if (!ctx.keys?.enabled || !Array.isArray(rows) || ctx.view.mode === "start") return null;
  return rows[ctx.view.selected] ?? null;
}

/** "working for 12m (turn-open)": the word, how long, and why, each only when the record says it. */
function stateLine(record, nowMs) {
  if (typeof record?.state !== "string" || !record.state) return "";
  const age = stateAge(record, nowMs);
  const cause = typeof record.stateCause === "string" && record.stateCause ? ` (${record.stateCause})` : "";
  return `${dashboardWord(record.state)}${age ? ` for ${age}` : ""}${cause}`;
}

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, ...}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, compact } = ctx;
  const row = selectedRow(ctx);
  if (!row) return [];
  const record = snapshot.agentRecords?.[row.label];
  const definition = snapshot.definitions?.[row.label];
  const state = stateLine(record, snapshot.nowMs);
  const note = [row.label || row.id, state].filter(Boolean).join(" · ");
  if (compact) return [heading("DETAIL", note, wide, on)];
  const said = (value) => (typeof value === "string" && value ? value : "");
  const fields = [
    ["title", said(row.title)], ["role", said(record?.role)], ["cwd", said(record?.launch?.cwd)],
    ["harness", said(definition?.harness)], ["model", said(definition?.model)], ["effort", said(definition?.effort)],
    ["state", state],
  ];
  const indent = 2 + LABEL_WIDTH + 2;
  const lines = ["", heading("DETAIL", note, wide, on)];
  for (const [label, value] of fields) {
    const name = paint(label.padEnd(LABEL_WIDTH), ["dim"], on);
    if (!value) { lines.push(`  ${name}  ${paint("—", ["dim"], on)}`); continue; }
    const wrapped = wrapToWidth(value, Math.max(10, wide - indent));
    lines.push(`  ${name}  ${wrapped[0]}`, ...wrapped.slice(1).map((line) => `${" ".repeat(indent)}${line}`));
  }
  return lines;
}
