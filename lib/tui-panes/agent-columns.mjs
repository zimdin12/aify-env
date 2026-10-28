// The agents pane's columns: every one it can draw, and the two sets it draws by default (0.9.6).
//
// THE OPERATOR'S ASK, 2026-10-28: drop the status word and the row number from the default view, put `out` right
// after the agent, keep id and pid for an extended view, and hide service and io by default. ~/.aify/tui.json may set
// either list (lib/tui-layout.mjs), and `v` switches between them. Which reading of "status-text" and "numeric id" the
// operator meant is asked on the dashboard (01M602WYZHBKGGD2SFA766V9MT); the default below is the reading stated
// there, and changing it is a change to these two lists only.
//
// THE NAMES ARE DERIVED FROM HERE: the layout file may only name a column in AGENT_COLUMNS.
//
// THE CELLS ARE THE ONES THE TABLE ALWAYS DREW, moved here from processes.mjs; the comments on why each looks as it
// does stay with the table there. `#` is drawn only with a keyboard: a piped render has nothing to jump with.
//
// THE CURSOR IS NOT THE NUMBER. It rode in the `#` cell, so dropping `#` from the default dropped the only mark of
// which agent the keys act on, and of whether Enter had put the keyboard inside one (`▶`). `cursor` is that mark
// alone; the default keeps it, and `#` (number and cursor) is in the extended set.

import { activityOf } from "../activity.mjs";
import { paint } from "../paint.mjs";
import { activityMark, rowMarker, shortHandle, statusCell, uptime } from "../tui-parts.mjs";

/** Which row the keys are on, and whether they are inside its agent: rowMarker's mark without its number. */
function rowCursor(at, view, on) {
  if (at !== view?.selected) return " ";
  return view?.mode === "pty" ? paint("▶", ["magenta", "bold"], on) : paint("❯", ["bold"], on);
}

/** The status dot alone, in the dashboard's colour: what `status` shows by default. */
function statusDot(state, on) {
  const cell = statusCell(state, on);
  return typeof state === "string" && state ? cell.slice(0, cell.lastIndexOf(" ")) : cell;
}

export const AGENT_COLUMNS = Object.freeze([
  { name: "cursor", header: "", keysOnly: true, cell: (proc, c) => rowCursor(c.at, c.view, c.on) },
  { name: "#", header: "#", keysOnly: true, cell: (proc, c) => rowMarker(c.at, c.view, c.on) },
  { name: "status", header: "status", cell: (proc, c) => statusDot(c.snapshot.agentStates?.[proc.label], c.on) },
  { name: "status-word", header: "status", cell: (proc, c) => statusCell(c.snapshot.agentStates?.[proc.label], c.on) },
  { name: "agent", header: "agent", cell: (proc, c) => (proc.label ? paint(proc.label, ["bold"], c.on) : paint("—", ["dim"], c.on)) },
  { name: "out", header: "out", cell: (proc, c) => activityMark(activityOf(proc, c.snapshot.nowMs), c.on) },
  { name: "id", header: "id", cell: (proc) => shortHandle(proc.id) },
  { name: "pid", header: "pid", cell: (proc) => String(proc.pid ?? "-") },
  { name: "service", header: "service", cell: (proc, c) => paint(proc.service ?? "", ["dim"], c.on) },
  { name: "io", header: "io", cell: (proc, c) => (proc.terminal ? paint("pty", ["green"], c.on) : paint("pipe", ["yellow"], c.on)) },
  { name: "up", header: "up", cell: (proc) => uptime(proc.uptimeMs) },
  { name: "title", header: "title", cell: (proc, c) => paint(proc.title || "", ["dim"], c.on) },
].map((column) => Object.freeze(column)));

export const DEFAULT_AGENT_COLUMNS = Object.freeze({
  normal: Object.freeze(["cursor", "status", "agent", "out", "up", "title"]),
  extended: Object.freeze(["#", "status-word", "agent", "out", "id", "pid", "service", "io", "up", "title"]),
});

/** The columns to draw, by name, leaving out `#` where there is no keyboard to jump with. */
export function agentColumns(names, keys) {
  return names.map((name) => AGENT_COLUMNS.find((column) => column.name === name))
    .filter((column) => column && (!column.keysOnly || keys?.enabled));
}
