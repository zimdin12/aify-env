// The order the agents table lists its rows in (0.9.7): by name, or what needs looking at first.
//
// THE OPERATOR'S ASK, 2026-10-28: "both, configurable", by name by default. `o` switches, ~/.aify/tui.json keeps it
// as `sort` (lib/tui-layout.mjs; `panes` there is the pane order, a different thing).
//
// THE NAMES ARE DERIVED FROM HERE: the layout file may only name a key of ROW_SORTS.
//
// ATTENTION IS DERIVED, NOT LISTED. First the states the palette paints red or does not know (the ones whose dot
// shows a cause), then agents with a turn open, then the rest, and an agent the environment did not report last:
// by name within each. A new state word lands in the right group without anyone editing a list.
//
// A REORDER NEVER MOVES THE CURSOR to another agent: lib/console-session.mjs re-points the selection by identity on
// every refresh, because attention order changes whenever a state does.

import { hueOf } from "../agent-status-palette.mjs";

const byLabel = (a, b) => String(a?.label ?? "").localeCompare(String(b?.label ?? ""));

/** 0 needs looking at, 1 working, 2 the rest, 3 not reported. PURE. */
export function attentionRank(record) {
  if (typeof record?.state !== "string" || !record.state) return 3;
  const hue = hueOf(record.state);
  if (hue === "red" || hue === "") return 0;
  return record.turn?.open ? 1 : 2;
}

export const ROW_SORTS = Object.freeze({
  name: (rows) => [...rows].sort(byLabel),
  attention: (rows, records) => [...rows].sort((a, b) =>
    attentionRank(records?.[a?.label]) - attentionRank(records?.[b?.label]) || byLabel(a, b)),
});

export const DEFAULT_ROW_SORT = "name";

/** The rows in `sort`'s order, a new array; an unknown sort is the default. PURE. */
export function sortRows(rows, records, sort) {
  const by = ROW_SORTS[sort] ?? ROW_SORTS[DEFAULT_ROW_SORT];
  return by(Array.isArray(rows) ? rows : [], records ?? {});
}
