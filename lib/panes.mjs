// Two views on one screen: the dashboard on the left, a chosen process on the right.
//
// THE OPERATOR ASKED FOR THIS FIRST -- "a right-side per-terminal pane with input". This module is
// the layout half of it, kept PURE and separate from any terminal: it takes two arrays of lines and
// returns one, so the whole geometry can be tested without a screen, a process or a keypress.
//
// IT COULD ONLY BE BUILT ONCE THE FULL CLEAR WENT. `dashboard.mjs` used to clear and repaint the
// whole screen twice a second; a pane carrying live process output on the right would have flickered
// unreadably against that. `frame.mjs` writes only what changed, which is what makes a second column
// worth having at all.
//
// WIDTH IS MEASURED, NEVER COUNTED. `width()` comes from `tui.mjs` rather than being reimplemented
// here, because it discounts SGR escapes: the left column is coloured by policy, and a padding
// function that counted escape bytes would push the divider a few characters right on exactly the
// rows that carry state -- a wandering divider that appears only when something is coloured.

import { clipToWidth as clipCore, pad, width } from "./tui.mjs";

// BUILT, NOT TYPED. The escape byte is invisible in a source file and does not survive a copy through
// a shell or a heredoc; writing the pattern without it is a bug that looks correct on the screen --
// the first draft of this module did exactly that, matching `[0;31m` while leaving the `\x1b` behind
// to be counted as a printable character.
const ESC = String.fromCharCode(27);
const SGR = `${ESC}\\[[0-9;]*m`;
const RESET = `${ESC}[0m`;

/** Between the columns. A vertical rule reads as a boundary in a way whitespace does not. */
export const DIVIDER = "│";

/**
 * The width available to the right pane once the left column and the divider have taken theirs.
 *
 * SEPARATE AND EXPORTED because the right pane has to render to a known width BEFORE it can be laid
 * out -- output has to be wrapped or clipped to fit, and it cannot be asked to do that without being
 * told the number. Two callers computing it independently is how a pane ends up one character wider
 * than the space it is given, which shifts every row below it.
 */
export function rightPaneWidth(columns, leftWidth, { gap = 1 } = {}) {
  const total = Math.max(0, Math.floor(columns) || 0);
  const left = Math.max(0, Math.floor(leftWidth) || 0);
  // left + gap + divider + gap + right
  return Math.max(0, total - left - (gap * 2) - width(DIVIDER));
}

/**
 * Lay two views side by side.
 *
 * THE SHORTER SIDE IS PADDED WITH BLANKS, not truncated to the shorter of the two. A dashboard with
 * nine rows beside a process with forty must not hide thirty-one of them, and a long dashboard beside
 * a quiet process must not lose its tail. The result is as tall as the taller side.
 *
 * A LEFT LINE WIDER THAN ITS COLUMN IS CLIPPED, not allowed to push the divider. The alternative is a
 * layout that silently changes shape when one value grows, which is the failure this whole module is
 * meant to prevent.
 *
 * NO ESCAPES ARE EMITTED HERE. Colour arrives inside the lines it was given; this only ever pads,
 * clips and joins, so a piped view of a composed frame carries exactly what its inputs carried.
 */
export function sideBySide(leftLines, rightLines, { columns = 100, leftWidth = null, gap = 1 } = {}) {
  const left = Array.isArray(leftLines) ? leftLines.map((l) => String(l ?? "")) : [];
  const right = Array.isArray(rightLines) ? rightLines.map((l) => String(l ?? "")) : [];

  // WITH NOTHING ON THE RIGHT, THIS IS A NO-OP. A dashboard with no pane open must render exactly as
  // it did before this module existed -- byte for byte, including its trailing spaces or lack of
  // them. Composing it against an empty column would pad every line to a fixed width and change a
  // screen nobody asked to change.
  if (!right.length) return left;

  const total = Math.max(0, Math.floor(columns) || 0);
  const lw = leftWidth === null
    ? Math.max(0, left.reduce((w, line) => Math.max(w, width(line)), 0))
    : Math.max(0, Math.floor(leftWidth) || 0);
  const rw = rightPaneWidth(total, lw, { gap });

  // NO ROOM IS AN HONEST ANSWER. On a narrow terminal there is no split worth drawing, and half a
  // divider with two characters of process output beside it is worse than the dashboard alone.
  if (rw <= 0) return left;

  const spacer = " ".repeat(gap);
  const height = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < height; i += 1) {
    const l = clipToWidth(left[i] ?? "", lw);
    const r = clipToWidth(right[i] ?? "", rw);
    // The right side is NOT padded: trailing blanks buy nothing at the end of a line and every one of
    // them is a byte the differential writer would have to send.
    out.push(`${pad(l, lw)}${spacer}${DIVIDER}${spacer}${r}`.replace(/\s+$/, ""));
  }
  return out;
}

/**
 * Cut a line to a column width, counting only what is visible.
 *
 * ESCAPES ARE KEPT WHOLE. Slicing a string by character index can cut an SGR sequence in half, and
 * half an escape does not colour anything -- it prints as garbage and, worse, leaves the terminal in
 * whatever state the truncated code left it, bleeding colour into every line below. So the scan walks
 * escapes atomically and only counts printable characters against the budget.
 */
export function clipToWidth(text, size) {
  // MOVED TO `tui.mjs`, beside `width` and `pad`, because the table renderer needed the same
  // behaviour and could not import it from here without a cycle. Kept as a named re-export: this is
  // the name the pane code and its tests already use, and one implementation is the whole point.
  return clipCore(text, size);
}
