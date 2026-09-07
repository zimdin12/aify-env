// How many COLUMNS a string occupies on a terminal, and how to cut it to a column budget.
//
// THE DEFECT THIS EXISTS FOR, confirmed by an independent review 2026-09-06 and measured: a CJK
// process title measured 78 by the old rule and occupied 113 cells. The row ran 33 columns past the
// right margin, wrapped, and the wrapped remainder landed on the row below -- which is where the
// HINT LINE lives. `frameUpdate` then believed that row already held the hint and never repainted
// it, so the keys stayed off screen until something unrelated changed that row.
//
// The old rule was `text.replace(SGR, "").length`: UTF-16 code units. That is wrong three ways.
//
//   翻訳          2 units,  4 cells   -- East Asian Wide is two columns
//   👍🏽           4 units,  2 cells   -- astral pairs, and a modifier that adds nothing
//   e + U+0301    2 units,  1 cell    -- a combining mark is drawn on the character before it
//
// ZERO DEPENDENCIES, and not by hand-rolling the hard half. `Intl.Segmenter` is built into Node and
// does GRAPHEME CLUSTERING -- so combining marks, emoji modifiers and ZWJ sequences are counted once,
// correctly, without a single range table. What is left for us is the narrow question "is this base
// character two columns wide", which is a stable published range list rather than an algorithm.
//
// AMBIGUOUS WIDTH IS TREATED AS NARROW, and that is a decision with a name on it. `●○❯▶─│·…↑↓` are
// all East Asian AMBIGUOUS: one column in a Latin locale, two in a CJK one. Windows Terminal with
// Cascadia -- the operator's terminal -- renders them narrow, as do iTerm2 and most others by
// default. A terminal configured ambiguous-as-wide will draw this view's rules and marks at double
// width and the layout will be wrong; that is a known limit, not an oversight, and it is written
// here so the next person meets it as a decision rather than a mystery.

/** Grapheme clustering, built once: constructing a Segmenter per call is measurably slower. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ESC = String.fromCharCode(27);
//: An SGR colour sequence. Colour occupies no columns. NOT exported: nothing outside needs the
//: pattern itself, and an export is a thing another module depends on.
const SGR_PATTERN = `${ESC}\\[[0-9;]*m`;
const SGR_RESET = `${ESC}[0m`;

/**
 * East Asian WIDE and FULLWIDTH ranges — the characters that take two columns.
 *
 * Transcribed from Unicode's `EastAsianWidth.txt` W and F classes, collapsed to the blocks that
 * actually occur in a process title or an agent's output. NOT the whole file: the omissions are all
 * historic scripts nobody is naming an agent after, and a missed range under-counts by one column on
 * a character this view has never seen. A wrong range in the other direction -- claiming two columns
 * for something narrow -- would misalign every row containing it, so the list errs toward narrow.
 */
const WIDE_RANGES = [
  [0x1100, 0x115f],   // Hangul Jamo initial consonants
  [0x2e80, 0x303e],   // CJK Radicals, Kangxi, CJK Symbols and Punctuation
  [0x3041, 0x33ff],   // Hiragana, Katakana, Bopomofo, Hangul Compat Jamo, Kanbun, Enclosed CJK
  [0x3400, 0x4dbf],   // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff],   // CJK Unified Ideographs
  [0xa000, 0xa4cf],   // Yi Syllables and Radicals
  [0xa960, 0xa97f],   // Hangul Jamo Extended-A
  [0xac00, 0xd7a3],   // Hangul Syllables
  [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  [0xfe10, 0xfe19],   // Vertical forms
  [0xfe30, 0xfe6f],   // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60],   // Fullwidth ASCII and punctuation
  [0xffe0, 0xffe6],   // Fullwidth currency and signs
  [0x1f300, 0x1f64f], // Emoji: symbols, pictographs, emoticons
  [0x1f680, 0x1f6ff], // Emoji: transport and map
  [0x1f900, 0x1f9ff], // Emoji: supplemental symbols
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extensions B and beyond
];

/** Columns for one grapheme cluster, judged by the base character it is built on. */
function clusterWidth(cluster) {
  const base = cluster.codePointAt(0);
  if (base === undefined) return 0;
  // A cluster whose base is a control character draws nothing. Callers strip these, but a width
  // function that charged a column for one would silently over-pad whatever slipped through.
  if (base < 0x20 || (base >= 0x7f && base <= 0x9f)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (base >= lo && base <= hi) return 2;
    if (base < lo) break;   // ranges are ordered, so nothing further can match
  }
  return 1;
}

/**
 * Printable width in terminal COLUMNS.
 *
 * EXPORTED and used by `panes.mjs` to pad a left column to an exact position. A second
 * implementation there would agree until one learned about a new escape, and the symptom would be a
 * divider that wanders by a character on some rows only.
 */
export function width(text) {
  const plain = String(text).replace(new RegExp(SGR_PATTERN, "g"), "");
  let total = 0;
  for (const { segment } of GRAPHEMES.segment(plain)) total += clusterWidth(segment);
  return total;
}

/** Pad to a column width, measuring what will actually be seen. */
export function pad(text, size) {
  const gap = size - width(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : String(text);
}

/**
 * Cut to a column budget without splitting an escape sequence or a grapheme.
 *
 * COUNTS COLUMNS, NOT CHARACTERS, so a budget of 10 fits five CJK characters rather than ten. And it
 * never cuts INSIDE a cluster: half of an emoji, or a base character without the accent that belongs
 * to it, is a mangled character rather than a shortened string.
 *
 * A WIDE CHARACTER THAT WOULD STRADDLE THE EDGE IS DROPPED rather than half-drawn. Terminals differ
 * on what they do with the leftover column; leaving it blank is the one behaviour that cannot
 * misalign the row.
 */
export function clipToWidth(text, size) {
  const value = String(text ?? "");
  const budget = Math.max(0, Math.floor(size) || 0);
  if (budget === 0) return "";
  if (width(value) <= budget) return value;

  const escape = new RegExp(SGR_PATTERN, "g");
  let out = "";
  let seen = 0;
  let at = 0;
  while (at < value.length && seen < budget) {
    escape.lastIndex = at;
    const m = escape.exec(value);
    if (m && m.index === at) {
      out += m[0];                       // an escape costs no columns and is copied whole
      at = escape.lastIndex;
      continue;
    }
    // One grapheme at a time, taken from the remaining text so a cluster is never split.
    const [first] = GRAPHEMES.segment(value.slice(at))[Symbol.iterator]();
    const cluster = first ? first.segment : value[at];
    const cost = clusterWidth(cluster);
    if (seen + cost > budget) break;     // a wide character that will not fit is left out entirely
    out += cluster;
    seen += cost;
    at += cluster.length;
  }
  // RESET AFTER A CUT, if anything was left open. A clipped line ending mid-colour tints every row
  // below it, the divider, and the pane beside it.
  return new RegExp(SGR_PATTERN).test(out) ? `${out}${SGR_RESET}` : out;
}

/**
 * The same cut, marked with an ellipsis, for a TABLE CELL.
 *
 * TWO BEHAVIOURS, NOT ONE. A pane LINE is a slice of somebody's terminal and an ellipsis would be a
 * character the process never printed; a table CELL cut without a mark reads as the whole value.
 */
export function clip(text, size) {
  const budget = Math.max(0, Math.floor(size) || 0);
  const value = String(text ?? "");
  if (budget === 0) return "";
  if (width(value) <= budget) return value;
  return `${clipToWidth(value, Math.max(0, budget - 1))}…`;
}
