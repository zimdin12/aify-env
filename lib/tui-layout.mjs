// Which panes the view shows, and in what order: ~/.aify/tui.json, the view's own file (0.9.6).
//
// THE OPERATOR'S ASK, 2026-10-28: "make panes and their columns configurable ... kept somewhere a restart preserves".
//
// ITS OWN FILE, NOT config.json. The operator and the plugins write ~/.aify/config.json, and a view that wrote it on
// every toggle would race their edits; this file is the view's, which the operator may also edit by hand.
//
// FAIL OPEN, like host-config.mjs: a view must never refuse to draw. A missing file is the defaults with nothing to
// say; one that cannot be read or parsed, or that names something unknown, is the defaults (or the parts that could
// be read) and a problem the view prints under its header, so a typo is seen rather than silently ignored.
//
//   {"version": 1, "panes": ["agents", "services", ...], "hidden": ["traffic"], "extended": false,
//    "columns": {"agents": {"normal": ["status", "agent", ...], "extended": ["#", "status-word", ...]}}}
//
// `panes` is the order. A known pane it leaves out is drawn after the ones it names, in default order, so a pane added
// in a later release still appears. Names come from lib/tui-panes/index.mjs, columns from lib/tui-panes/agent-columns.mjs.
// `extended` is which column set the agents pane draws; `v` switches it and writes it back (writeLayoutChange).

import fs from "node:fs";
import path from "node:path";

import { writeFileDurably } from "./durable-file.mjs";
import { AGENT_COLUMNS, DEFAULT_AGENT_COLUMNS } from "./tui-panes/agent-columns.mjs";
import { PANES } from "./tui-panes/index.mjs";

const KNOWN = new Set(PANES.map((pane) => pane.name));
const REQUIRED = new Set(PANES.filter((pane) => pane.required).map((pane) => pane.name));
const COLUMN_NAMES = new Set(AGENT_COLUMNS.map((column) => column.name));

/** Where the view's layout lives under a home directory. */
export function tuiLayoutPath(home) {
  return path.join(home, ".aify", "tui.json");
}

/** The names in `value` this view knows, each once, and a problem for every one it does not. */
function namesFrom(value, field, problems) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${field} is not a list of pane names`);
    return [];
  }
  const out = [];
  for (const name of value) {
    if (!KNOWN.has(name)) problems.push(`${field} names ${JSON.stringify(name)}, which is not a pane (panes: ${[...KNOWN].join(", ")})`);
    else if (out.includes(name)) problems.push(`${field} names ${name} twice`);
    else out.push(name);
  }
  return out;
}

/**
 * PURE. The layout a file's text asks for.
 *
 * @param {string|null} text  the file's contents, or null when there is no file
 * @returns {{order: string[], hidden: Set<string>, extended: boolean,
 *            columns: {normal: string[], extended: string[]}, problems: string[]}}
 */
export function layoutFrom(text) {
  const problems = [];
  let parsed = {};
  if (typeof text === "string" && text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push("is not JSON, so the default layout is used");
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push("is not an object, so the default layout is used");
      parsed = {};
    }
  }
  const named = namesFrom(parsed.panes, "panes", problems);
  const order = [...named, ...PANES.map((pane) => pane.name).filter((name) => !named.includes(name))];
  const hidden = new Set();
  for (const name of namesFrom(parsed.hidden, "hidden", problems)) {
    if (REQUIRED.has(name)) problems.push(`hidden names ${name}, which cannot be hidden: its keys act on it`);
    else hidden.add(name);
  }
  if (parsed.extended !== undefined && typeof parsed.extended !== "boolean") problems.push("extended is not true or false");
  const extended = parsed.extended === true;
  const agents = parsed.columns?.agents;
  const columns = {
    normal: columnsFrom(agents?.normal, "columns.agents.normal", DEFAULT_AGENT_COLUMNS.normal, problems),
    extended: columnsFrom(agents?.extended, "columns.agents.extended", DEFAULT_AGENT_COLUMNS.extended, problems),
  };
  return { order, hidden, extended, columns, problems };
}

/** A column list as written, or the default with a problem. A list without `agent` names no row, so it is refused. */
function columnsFrom(value, field, fallback, problems) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.length) {
    problems.push(`${field} is not a list of column names, so the default is used`);
    return [...fallback];
  }
  const out = [];
  for (const name of value) {
    if (!COLUMN_NAMES.has(name)) problems.push(`${field} names ${JSON.stringify(name)}, which is not a column (columns: ${[...COLUMN_NAMES].join(", ")})`);
    else if (out.includes(name)) problems.push(`${field} names ${name} twice`);
    else out.push(name);
  }
  if (!out.includes("agent")) {
    problems.push(`${field} has no agent column, so its rows would name nobody; the default is used`);
    return [...fallback];
  }
  return out;
}

/** From disk. Never throws: an unreadable file is the defaults and says so. */
export function readLayout({ home, env = process.env, readFile = fs.readFileSync } = {}) {
  let text = null;
  try {
    text = readFile(tuiLayoutPath(home ?? (env.USERPROFILE || env.HOME || "")), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { ...layoutFrom(null), problems: [`could not be read (${error?.code || error?.message || error}), so the default layout is used`] };
    }
  }
  return layoutFrom(text);
}

/**
 * Write one change to the layout file, keeping everything else in it, or refuse.
 *
 * NEVER OVER WHAT THE OPERATOR WROTE BY HAND (comms-tech-lead's review, 2026-10-28). A file that cannot be read, or
 * that does not parse cleanly, is left byte for byte as it is and the refusal says why: a toggle must not be how a
 * half-edited file is lost. A missing file is created with the change alone.
 *
 * @param {object} change  the fields to set, e.g. {extended: true}
 * @returns {{written: boolean, problem: string}}
 */
export function writeLayoutChange(change, { home, env = process.env, readFile = fs.readFileSync, write = writeFileDurably,
  mkdir = fs.mkdirSync } = {}) {
  const file = tuiLayoutPath(home ?? (env.USERPROFILE || env.HOME || ""));
  let current = { version: 1 };
  try {
    const text = readFile(file, "utf8");
    if (layoutFrom(text).problems.length) {
      return { written: false, problem: "~/.aify/tui.json has problems (shown above), so it is not rewritten: fix it by hand" };
    }
    if (text.trim()) current = JSON.parse(text);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { written: false, problem: `~/.aify/tui.json could not be read (${error?.code || error?.message || error}), so it is not rewritten` };
    }
  }
  try {
    mkdir(path.dirname(file), { recursive: true });
    write(file, `${JSON.stringify({ ...current, ...change }, null, 2)}
`);
    return { written: true, problem: "" };
  } catch (error) {
    return { written: false, problem: `~/.aify/tui.json could not be written: ${error?.message || error}` };
  }
}
