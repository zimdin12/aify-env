// The pieces every pane of the view is drawn with: cells, marks, headings, tables and the hint fitter.
//
// MOVED VERBATIM out of lib/tui.mjs (0.9.6), which had grown to 921 lines holding the whole dashboard in one
// function. The argument for each piece is the comment beside it, unchanged; lib/tui.mjs's header still holds the
// view's rules.

import { QUIET, WORKING } from "./activity.mjs";
import { dashboardWord, hueOf } from "./agent-status-palette.mjs";
import { paint } from "./paint.mjs";
import { clip, displayable, pad, width } from "./text-width.mjs";

/**
 * A handle, narrowed for a column, without narrowing the handle.
 *
 * A handle is `<uuid>-p<n>`: the uuid says which INSTANCE of this environment minted it, so a
 * consumer holding one across a restart cannot match a process the next instance happened to number
 * the same. Thirty-nine characters is right for identity and wrong for a table, and the fix is a
 * projection here rather than a shorter identity there -- an id trimmed to fit a column is an id that
 * collides to fit a column.
 *
 * The LAST four of the uuid, not the first: two boots differ everywhere, and the tail sits next to the
 * process number where a reader is already looking.
 *
 * THE PROJECTION IS NOT AN IDENTITY and must never be compared as one. Four hex characters collide
 * once in 65,536, which is fine for telling two rows apart on a screen and useless for deciding
 * whether two handles are the same. Nothing but the renderer may call this.
 */
export function shortHandle(id) {
  const value = String(id ?? "");
  const cut = value.lastIndexOf("-p");
  if (cut <= 0) return value;
  return `${value.slice(Math.max(0, cut - 4), cut)}${value.slice(cut)}`;
}

/**
 * What each menu action DOES, in one line (v0.7 scan, F17).
 *
 * The rows were bare verbs, and the confirmation asked "stop alpha?" without saying that stop ends
 * the whole process tree at once, mid-turn. Keyed by the full vocabulary, and a test walks it, so an
 * action added to the menu cannot arrive without saying what it does.
 */
export const ACTION_EFFECTS = Object.freeze({
  attach: "your keys go into its terminal",
  restart: "ends it and starts it again; its context is lost",
  stop: "ends its process tree now — its current turn is lost",
});



// A GLYPH AND THE WORD, never the glyph alone. Colour and shape both fail -- a piped view, a
// colour-blind reader, a terminal without the font -- and the distinction between "did not answer" and
// "answered badly" is the one a viewer acts on: silent may mean switched off, and showing it as broken
// sends somebody to debug a service that is simply not running today.
export const STATE_STYLE = {
  passed: { mark: "●", word: "ok", codes: ["green"] },
  failed: { mark: "●", word: "failed", codes: ["red"] },
  unanswered: { mark: "◌", word: "unanswered", codes: ["yellow"] },
};

/**
 * The row's number, and whether the keyboard is sitting on it.
 *
 * `❯` MEANS SELECTED AND `▶` MEANS ATTACHED, and the difference is the one an operator most needs:
 * attached, every subsequent keystroke -- Ctrl+C included -- goes into a live agent's PTY. Nothing
 * said so before, because `pane.attached` had no reader and the pane itself is hidden below 80
 * columns, so a narrow terminal gave no signal at all that Enter had handed the keyboard away.
 *
 * PAST NINE THERE IS NO NUMBER, because there is no key to press. Printing `10` beside rows nothing
 * can jump to would promise a binding that does not exist.
 */
export function rowMarker(at, view, on) {
  const selected = at === view?.selected;
  const cursor = selected ? (view?.mode === "pty" ? "▶" : "❯") : " ";
  const number = at < 9 ? String(at + 1) : " ";
  const text = `${cursor}${number}`;
  return selected ? paint(text, view?.mode === "pty" ? ["magenta", "bold"] : ["bold"], on) : paint(text, ["dim"], on);
}

/**
 * The activity mark for one row: producing, quiet, or nothing measured.
 *
 * NOTHING AT ALL FOR `unknown`, rather than a third symbol. A process that has not emitted yet and a
 * daemon too old to report the field are both "no evidence", and a glyph for that would compete for
 * the eye with the two that mean something. The column still holds its width, so the table does not
 * jump when a lane's first frame arrives.
 */
export function activityMark(state, on) {
  // NO STATUS COLOUR. This says a process printed in the last three seconds, which is not working:
  // an idle hermes redraws its status-bar clock every second (measured 2026-09-29), so the
  // dashboard's working amber here put every hermes permanently "working".
  if (state === WORKING) return "●";
  if (state === QUIET) return paint("○", ["grey"], on);
  return " ";
}

/** An agent's status as the dashboard shows it, its dot in the dashboard's colour; a dim dash when there is no word. */
export function statusCell(state, on) {
  if (typeof state !== "string" || !state) return paint("—", ["dim"], on);
  const hue = hueOf(state);
  return `${hue ? paint("●", [hue], on) : "○"} ${dashboardWord(state)}`;
}

/**
 * As many hints as fit WHOLE, in display order, dropping the least useful first.
 *
 * THE ONE-GUARANTEE CLIP AT THE END OF THIS FILE CUTS THE TAIL, and for the hint line the tail is
 * where `q quit` lives. Measured 2026-09-08 at the DEFAULT width of 100 columns: adding `s start`
 * took the line to 105 and `q quit` vanished -- so the key that says how to leave was lost to a key
 * that says how to start something, silently, on an ordinary terminal. A hint cut mid-item is worse
 * than one that is shorter: `p…` teaches nothing and looks like a rendering fault.
 *
 * PRIORITY IS NOT DISPLAY ORDER, deliberately. An operator reads left to right and expects movement
 * first, so the ORDER is fixed; what changes under pressure is which items are there at all. The
 * ones that go first are the ones an operator can discover without being told -- arrows, digits,
 * Enter -- and the ones that survive longest are the letters that exist nowhere else on the screen.
 *
 * @param {Array<{text: string, drop: number}>} items display order, `drop` = dropped first when high
 */
export function fittedHints(items, columns, separator) {
  const room = Math.max(0, columns - 2);
  const ordered = [...items].sort((a, b) => b.drop - a.drop);
  const dropped = new Set();
  for (;;) {
    const kept = items.filter((item) => !dropped.has(item));
    const text = kept.map((item) => item.text).join(separator);
    if (width(text) <= room || kept.length <= 1) return text;
    // The highest `drop` still present goes next.
    dropped.add(ordered.find((item) => !dropped.has(item)));
  }
}

/** Whole minutes; a view that re-renders on a second boundary is a view that never sits still. */
export function uptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * How long ago, in words. Null when there is no timestamp OR no reference point -- a view that
 * invents "just now" from a missing clock is worse than one that says nothing.
 *
 * The reference time is PASSED IN for the same reason uptime arrives pre-computed: a clock inside a
 * renderer makes the same snapshot render differently in a test than on a screen.
 */
export function relativeAge(atMs, nowMs) {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null;
  const seconds = Math.floor((nowMs - atMs) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
}

/**
 * One phrase for how a process ended, and the three answers stay apart.
 *
 * A SIGNAL means something killed it, and is worth the operator's attention -- painted, not dimmed.
 * A CODE means it stopped on its own; zero is a clean exit and the most common value there is, so it
 * is reported rather than dropped by a truthiness test. NEITHER means nobody observed the exit -- a
 * reaper found a corpse, or a caller asked for a stop -- and saying so plainly is the honest answer,
 * not a gap to fill with a zero.
 */
export function exitDescription(exit, on) {
  const signal = String(exit?.exitSignal ?? "").trim();
  if (signal) return paint(`killed by ${signal}`, ["red"], on);
  const code = exit?.exitCode;
  if (code === null || code === undefined) {
    // NOT A BLANK. The first real reading of this panel showed two deaths as "no exit reported",
    // which already proved they were REMOVED rather than observed exiting -- a process that ends on
    // its own always arrives through the close event with a code or a signal. What it could not say
    // was by whom, and "somebody asked for a stop" and "the sweep found a corpse" are different
    // incidents. So the reason is the answer here, not a footnote.
    const reason = String(exit?.reason ?? "");
    if (reason === "stopped") return paint("stopped on request", ["yellow"], on);
    if (reason === "reaped") return paint("found already gone", ["yellow"], on);
    return paint("no exit reported", ["dim"], on);
  }
  return Number(code) === 0
    ? paint("exited cleanly (0)", ["dim"], on)
    : paint(`exited ${Number(code)}`, ["yellow"], on);
}

/**
 * A service's detail, minus the endpoint this row has already drawn in its own column.
 *
 * `probeService` builds "<endpoint> reports healthy version 0.6.1 build b7d77fdf", and it is RIGHT
 * to: `aify-env doctor` prints the same string with no endpoint column, so the address has to be in
 * the sentence there. Here it is the fourth column of the same row.
 *
 * IT COSTS THE INFORMATION, NOT JUST THE SPACE. `table` gives the LAST column whatever width is
 * left and clips it, so on a narrow terminal the part that gets cut is the version and build --
 * exactly what somebody checking whether a deploy landed is reading the row for -- while the
 * duplicate address survives. Twenty-two characters of `http://127.0.0.1:8800 ` in front of it.
 *
 * PREFIX ONLY, deliberately. The unanswered details read "no answer from <endpoint>: ECONNREFUSED",
 * where the address is inside a sentence; cutting it there would leave "no answer from : ..." and
 * trade a duplicate for a mangling.
 */
export function withoutLeadingEndpoint(detail, endpoint) {
  const text = String(detail ?? "");
  const address = String(endpoint ?? "");
  if (!address || !text.startsWith(`${address} `)) return text;
  return text.slice(address.length + 1);
}

/**
 * A section heading with a rule to the full width, so sections separate without boxing everything.
 */
export function heading(title, note, columns, on) {
  const label = paint(title, ["bold"], on);
  const tail = note ? ` ${paint(note, ["dim"], on)}` : "";
  const used = width(label) + width(tail) + 1;
  const rule = columns > used ? paint("─".repeat(columns - used), ["grey"], on) : "";
  return `${label}${tail} ${rule}`;
}

/**
 * Render aligned rows under dim headers. Widths come from the content, and the LAST column absorbs
 * whatever is left so a long detail truncates instead of wrapping.
 */
export function table(headers, rows, columns, on) {
  if (!rows.length) return [];
  // EVERY CELL IS ONE ROW OF TEXT AND COLOUR (v0.7 scan, F4). A newline in any cell split a frame row
  // under a writer that addresses rows absolutely, and titles and notices were each sanitised at
  // their own producer -- so the next producer nobody sanitised would do it again. Guarded here, once.
  rows = rows.map((row) => row.map((cell) => displayable(cell)));
  const sizes = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => width(String(r[i] ?? "")))));
  // Two spaces between columns; the last one takes the remainder.
  const fixed = sizes.slice(0, -1).reduce((sum, s) => sum + s + 2, 0);
  // NO FLOOR ABOVE THE BUDGET. `Math.max(8, ...)` won whenever the fixed columns nearly filled the
  // screen, and the row then ran `2 + fixed + 8` wide regardless -- measured at up to 15 columns
  // past the margin with the operator's real agent names. A table that cannot fit says less rather
  // than spilling: the last column gets whatever is left, even if that is nothing.
  const last = Math.max(0, columns - fixed - 2);
  const out = [`  ${headers.map((h, i) =>
    paint(pad(h.toUpperCase(), i === headers.length - 1 ? h.length : sizes[i]), ["dim"], on),
  ).join("  ")}`];
  for (const row of rows) {
    const cells = row.map((cell, i) => (i === headers.length - 1
      ? clip(String(cell ?? ""), last)
      : pad(String(cell ?? ""), sizes[i])));
    out.push(`  ${cells.join("  ")}`);
  }
  return out;
}
