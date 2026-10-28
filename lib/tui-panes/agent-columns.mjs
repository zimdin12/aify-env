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
import { hueOf } from "../agent-status-palette.mjs";
import { activityMark, rowMarker, shortHandle, statusCell, uptime } from "../tui-parts.mjs";

/** Which row the keys are on, and whether they are inside its agent: rowMarker's mark without its number. */
function rowCursor(at, view, on) {
  if (at !== view?.selected) return " ";
  return view?.mode === "pty" ? paint("▶", ["magenta", "bold"], on) : paint("❯", ["bold"], on);
}

/**
 * What follows an agent's dot: why, when its state needs looking at, else for how long (0.9.7).
 *
 * WHY, ONLY WHERE THE DOT CANNOT SAY IT. A cause shows when the palette paints the state red or does not know it
 * (`blocked: folder-trust`, `unknown: identity-unknown`), derived from the palette rather than listed. Every other
 * cause (at-prompt, turn-open, operator-stop, startable, absent, config) only repeats what the dot already says.
 *
 * FOR HOW LONG: an open turn since it started, a closed one since its last event, from the snapshot's clock (the view
 * reads none of its own). Nothing when the record does not say.
 */
export function stateSuffix(record, nowMs) {
  const state = record?.state;
  if (typeof state !== "string" || !state) return "";
  const hue = hueOf(state);
  if (hue === "red" || hue === "") return typeof record.stateCause === "string" ? record.stateCause : "";
  return stateAge(record, nowMs);
}

/** For how long, whatever the state's hue: the `age` column, and the dot's suffix where no cause shows. PURE. */
function stateAge(record, nowMs) {
  const turn = record?.turn;
  const sinceUs = turn?.open ? turn.startedAtUs : turn?.lastEventAtUs;
  if (!Number.isSafeInteger(sinceUs) || sinceUs <= 0 || !Number.isFinite(nowMs)) return "";
  const age = nowMs - Math.floor(sinceUs / 1000);
  return age >= 0 ? uptime(age) : "";
}

/** A text field of the agent's record, or "" when the record does not carry one: a blank, never a guessed value. */
const said = (value) => (typeof value === "string" ? value : "");

/** The status dot and its suffix, in the dashboard's colour: what `status` shows by default ("● 12m"). */
function statusDot(record, nowMs, on) {
  const state = record?.state;
  const cell = statusCell(state, on);
  const dot = typeof state === "string" && state ? cell.slice(0, cell.lastIndexOf(" ")) : cell;
  const suffix = stateSuffix(record, nowMs);
  return suffix ? `${dot} ${suffix}` : dot;
}

/** The dot, the word and the suffix: the extended set's `status-word` ("● working 12m"), and the roster's status. */
export function statusWord(record, nowMs, on) {
  const suffix = stateSuffix(record, nowMs);
  const cell = statusCell(record?.state, on);
  return suffix ? `${cell} ${suffix}` : cell;
}

export const AGENT_COLUMNS = Object.freeze([
  { name: "cursor", header: "", keysOnly: true, cell: (proc, c) => rowCursor(c.at, c.view, c.on) },
  { name: "#", header: "#", keysOnly: true, cell: (proc, c) => rowMarker(c.at, c.view, c.on) },
  // NO HEADER over the dot (0.9.7): "status" padded a one-character dot to six on every row, the width a title needs.
  { name: "status", header: "", cell: (proc, c) => statusDot(c.snapshot.agentRecords?.[proc.label], c.snapshot.nowMs, c.on) },
  { name: "status-word", header: "status", cell: (proc, c) => statusWord(c.snapshot.agentRecords?.[proc.label], c.snapshot.nowMs, c.on) },
  { name: "agent", header: "agent", cell: (proc, c) => (proc.label ? paint(proc.label, ["bold"], c.on) : paint("—", ["dim"], c.on)) },
  { name: "out", header: "out", cell: (proc, c) => activityMark(activityOf(proc, c.snapshot.nowMs), c.on) },
  { name: "id", header: "id", cell: (proc) => shortHandle(proc.id) },
  { name: "pid", header: "pid", cell: (proc) => String(proc.pid ?? "-") },
  { name: "service", header: "service", cell: (proc, c) => paint(proc.service ?? "", ["dim"], c.on) },
  { name: "io", header: "io", cell: (proc, c) => (proc.terminal ? paint("pty", ["green"], c.on) : paint("pipe", ["yellow"], c.on)) },
  { name: "up", header: "up", cell: (proc) => uptime(proc.uptimeMs) },
  { name: "title", header: "title", cell: (proc, c) => paint(proc.title || "", ["dim"], c.on) },
  // MORE TO CHOOSE (0.9.9), in neither default set: each is the agent record's own field, blank when it has none.
  { name: "role", header: "role", cell: (proc, c) => said(c.snapshot.agentRecords?.[proc.label]?.role) },
  { name: "cwd", header: "cwd", cell: (proc, c) => paint(said(c.snapshot.agentRecords?.[proc.label]?.launch?.cwd), ["dim"], c.on) },
  { name: "age", header: "age", cell: (proc, c) => stateAge(c.snapshot.agentRecords?.[proc.label], c.snapshot.nowMs) },
  { name: "cause", header: "cause", cell: (proc, c) => said(c.snapshot.agentRecords?.[proc.label]?.stateCause) },
  // What its definition says it runs as, from this host's store read without a lock (DefinitionStore.readOnlySummary).
  { name: "harness", header: "harness", cell: (proc, c) => said(c.snapshot.definitions?.[proc.label]?.harness) },
  { name: "model", header: "model", cell: (proc, c) => said(c.snapshot.definitions?.[proc.label]?.model) },
  { name: "effort", header: "effort", cell: (proc, c) => said(c.snapshot.definitions?.[proc.label]?.effort) },
].map((column) => Object.freeze(column)));

export const DEFAULT_AGENT_COLUMNS = Object.freeze({
  normal: Object.freeze(["cursor", "status", "agent", "out", "title"]),
  extended: Object.freeze(["#", "status-word", "agent", "out", "id", "pid", "service", "io", "up", "title"]),
});

/** The columns to draw, by name, leaving out `#` where there is no keyboard to jump with. */
export function agentColumns(names, keys) {
  return names.map((name) => AGENT_COLUMNS.find((column) => column.name === name))
    .filter((column) => column && (!column.keysOnly || keys?.enabled));
}
