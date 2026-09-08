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

//: COMPILED ONCE. `width` ran `new RegExp(SGR_PATTERN, "g")` on every call, and it is called for
//: every cell string of every row of every frame. A CPU profile of one 40-process frame put 70% of
//: the whole frame inside `width`.
//:
//: SAFE TO SHARE ONLY FOR `replace` AND A NON-GLOBAL `test`. A global regex carries `lastIndex`, so
//: an instance driven by `exec` in a loop must stay private -- `clipToWidth` keeps its own for
//: exactly that reason. `String.replace` with a global regex resets `lastIndex` itself, and `test`
//: on a NON-global regex never consults it.
const SGR_GLOBAL = new RegExp(SGR_PATTERN, "g");
const SGR_ONCE = new RegExp(SGR_PATTERN);

//: Printable ASCII: every one of these is exactly one column, carries no combining mark, and cannot
//: begin an escape (ESC is 0x1b, below the range). So a string made only of them has width ===
//: length, with no regex and no segmenter. Almost every string a dashboard row is built from is in
//: this set, and the general path still runs for anything that is not.
const ASCII_LOW = 0x20;
const ASCII_HIGH = 0x7e;

function isPlainAscii(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < ASCII_LOW || code > ASCII_HIGH) return false;
  }
  return true;
}

//: MEASURED WIDTHS, REMEMBERED. The ASCII shortcut above misses most of what a dashboard row is
//: actually made of -- `─ │ ● ❯ …` and an em dash all sit above 0x7e -- and a profile taken AFTER
//: adding it still put 68% of a 40-process frame inside this function. Extending the shortcut to
//: cover those characters would mean a second copy of the width table, which is the duplication this
//: module exists to avoid.
//:
//: SO CACHE THE ANSWER INSTEAD OF RE-DERIVING THE RULE. `width` is a pure function of its string, so
//: a remembered result is never stale. The expensive half is `Intl.Segmenter`, which is an ICU call
//: per string, and a view redraws the same labels, rules and status words on every frame.
//:
//: BOUNDED, AND THE BOUND IS THE POINT. This is module-scope mutable state on a path that sees
//: arbitrary terminal output, so it must not grow with it. Insertion order gives the eviction for
//: free. A frame is a couple of hundred distinct strings, so the whole of several frames fits and
//: only genuinely novel text evicts anything.
const WIDTH_MEMO = new Map();
const WIDTH_MEMO_ENTRIES = 4096;
//: A long string is unlikely to be asked for twice and is the expensive thing to hold.
const WIDTH_MEMO_MAX_KEY = 512;

/**
 * How many widths are currently remembered.
 *
 * EXPORTED FOR ONE REASON: the bound is the safety property of this cache, and a bound nothing
 * measures is a comment. This path is fed by arbitrary terminal output, so a cache that grew with it
 * would be a slow memory leak that no correctness test could ever notice -- every answer would still
 * be right. Named so no caller mistakes it for part of the width API.
 */
export function widthMemoSizeForTests({ reset = false } = {}) {
  //: RESET, because a test that inherits a FULL cache cannot see growth: at the bound every
  //: insertion evicts one and the size never moves. A mutant that cached over-long strings survived
  //: for exactly that reason -- the assertion was vacuous, not wrong.
  if (reset) WIDTH_MEMO.clear();
  return WIDTH_MEMO.size;
}

/**
 * A key this cache OWNS, with no parent behind it.
 *
 * V8 represents `big.slice(a, b)` as a SlicedString that points AT `big`, so holding the slice holds
 * the whole parent. A PANE LINE IS A SLICE OF TERMINAL OUTPUT, which is the demonstrated case and
 * the one that matters, since terminal output is unbounded. (An earlier version of this comment also
 * claimed process titles arrive as slices of a JSON body; review's round-trip control was NEGATIVE,
 * so that claim is withdrawn rather than kept as colour.)
 *
 * MEASURED before this existed: 32 cached slices of 120 units, taken from parents of about a MiB
 * each, held 40,634,424 bytes — against 3,840 logical units cached. The entry bound and the
 * key-length bound were both being honoured the whole time, which is why neither could catch it.
 * (External review of c74927a.)
 *
 * `charCodeAt` and `fromCharCode` are an exact UTF-16 round trip, so a lone surrogate survives it.
 * Copying through UTF-8 would not: it would replace unpaired surrogates and silently change the key,
 * and a key that is not the string it stands for returns another string's width.
 *
 * BOUNDED FOR REAL NOW: at most WIDTH_MEMO_ENTRIES keys of at most WIDTH_MEMO_MAX_KEY units. That
 * is about 4 MB of CHARACTER PAYLOAD in the worst case — not a total heap figure, which would also
 * carry the Map's own structure and a string header per key. What matters is that the bound no
 * longer depends on the size of whatever the keys were sliced from.
 */
function ownedKey(value) {
  const units = new Array(value.length);
  for (let i = 0; i < value.length; i += 1) units[i] = value.charCodeAt(i);
  return String.fromCharCode(...units);
}

function rememberWidth(value, measured) {
  if (value.length > WIDTH_MEMO_MAX_KEY) return measured;
  if (WIDTH_MEMO.size >= WIDTH_MEMO_ENTRIES) {
    WIDTH_MEMO.delete(WIDTH_MEMO.keys().next().value);
  }
  // Looked up by VALUE, so an owned copy is found by the caller's original string.
  WIDTH_MEMO.set(ownedKey(value), measured);
  return measured;
}

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
  [0x231a, 0x231b],   // watch, hourglass — Emoji_Presentation despite living in Misc Technical
  [0x23e9, 0x23ec],   // media buttons
  [0x23f0, 0x23f0],   // alarm clock
  [0x23f3, 0x23f3],   // hourglass flowing
  [0x25fd, 0x25fe],   // small squares with emoji presentation
  [0x2614, 0x2615],   // umbrella, hot beverage
  [0x2648, 0x2653],   // zodiac
  [0x267f, 0x267f],   // wheelchair
  [0x2693, 0x2693],   // anchor
  [0x26a1, 0x26a1],   // high voltage
  [0x26aa, 0x26ab],   // circles
  [0x26bd, 0x26be],   // football, baseball
  [0x26c4, 0x26c5],   // snowman, sun behind cloud
  [0x26ce, 0x26ce],   // ophiuchus
  [0x26d4, 0x26d4],   // no entry
  [0x26ea, 0x26ea],   // church
  [0x26f2, 0x26f3],   // fountain, golf
  [0x26f5, 0x26f5],   // sailboat
  [0x26fa, 0x26fa],   // tent
  [0x26fd, 0x26fd],   // fuel pump
  [0x2705, 0x2705],   // white heavy check mark
  [0x270a, 0x270b],   // fists
  [0x2728, 0x2728],   // sparkles
  [0x274c, 0x274c],   // cross mark
  [0x274e, 0x274e],   // negative squared cross
  [0x2753, 0x2755],   // question and exclamation ornaments
  [0x2757, 0x2757],   // heavy exclamation
  [0x2795, 0x2797],   // heavy plus, minus, divide
  [0x27b0, 0x27b0],   // curly loop
  [0x27bf, 0x27bf],   // double curly loop
  [0x2b1b, 0x2b1c],   // large squares
  [0x2b50, 0x2b50],   // star
  [0x2b55, 0x2b55],   // heavy large circle
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
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // joker
  [0x1f18e, 0x1f18e], // AB button
  [0x1f191, 0x1f19a], // squared latin abbreviations
  [0x1f1e6, 0x1f1ff], // REGIONAL INDICATORS — a flag is a PAIR, and the pair is one grapheme
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x1f300, 0x1f64f], // Emoji: symbols, pictographs, emoticons
  [0x1f680, 0x1f6ff], // Emoji: transport and map
  [0x1f7e0, 0x1f7eb], // coloured circles and squares
  [0x1f900, 0x1f9ff], // Emoji: supplemental symbols
  [0x1fa70, 0x1faff], // Extended-A — melting face and everything after it
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extensions B and beyond
];

//: U+FE0F asks for the EMOJI presentation of a character that is text by default, and emoji
//: presentation is two cells. `2764` is a one-cell heart; `2764 FE0F` is a two-cell one, and the
//: same rule makes a keycap and a styled check mark wide. Judging by the base alone missed all of
//: them -- review measured a row admitted as 80 cells occupying 115.
const EMOJI_PRESENTATION = 0xfe0f;
//: U+20E3 turns the character before it into a keycap, which is drawn two cells wide.
const COMBINING_KEYCAP = 0x20e3;

/**
 * Columns for one grapheme cluster.
 *
 * THE WHOLE CLUSTER, NOT JUST ITS BASE. A cluster carrying an emoji-presentation selector or a keycap
 * mark is two cells however narrow its base character is, and a regional-indicator pair -- one
 * grapheme, two code points -- is one flag two cells wide rather than two of anything.
 */
function clusterWidth(cluster) {
  const base = cluster.codePointAt(0);
  if (base === undefined) return 0;
  // A cluster whose base is a control character draws nothing. Callers strip these, but a width
  // function that charged a column for one would silently over-pad whatever slipped through.
  if (base < 0x20 || (base >= 0x7f && base <= 0x9f)) return 0;
  for (const point of cluster) {
    const code = point.codePointAt(0);
    if (code === EMOJI_PRESENTATION || code === COMBINING_KEYCAP) return 2;
  }
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
  const value = String(text);
  // THE FAST PATH IS NOT A SECOND RULE, it is the general rule with the work skipped where the
  // answer is already known: every printable ASCII character is one column. It is checked against
  // the general path over a corpus in the tests, so the two cannot drift.
  if (isPlainAscii(value)) return value.length;
  const remembered = WIDTH_MEMO.get(value);
  if (remembered !== undefined) return remembered;
  const plain = value.replace(SGR_GLOBAL, "");
  let total = 0;
  for (const { segment } of GRAPHEMES.segment(plain)) total += clusterWidth(segment);
  return rememberWidth(value, total);
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

  // SEGMENTED ON THE SAME BYTES `width` MEASURES, which is the whole of finding R10's second half.
  // `width` strips SGR and then segments; this used to segment the RAW string, so an escape sitting
  // between a letter and its combining mark split one grapheme into two. Measured:
  // `clipToWidth("e" + ESC + "[31m" + U+0301 + "x", 1)` dropped the accent while the unstyled string
  // kept it -- two functions disagreeing about where a character begins.
  //
  // So the graphemes come from the STRIPPED text, and the escapes are put back where they were:
  // walk the original, emit any escape as it is reached, and otherwise consume the characters of the
  // next stripped grapheme. Escapes occupy no columns, so the non-escape characters of the original
  // are exactly the stripped text, in order.
  const escape = new RegExp(SGR_PATTERN, "g");
  const plain = value.replace(SGR_GLOBAL, "");
  const clusters = [...GRAPHEMES.segment(plain)].map((piece) => piece.segment);

  let out = "";
  let seen = 0;
  let at = 0;
  for (const cluster of clusters) {
    const cost = clusterWidth(cluster);
    if (seen + cost > budget) break;     // a wide character that will not fit is left out entirely
    let taken = 0;
    while (taken < cluster.length && at < value.length) {
      escape.lastIndex = at;
      const m = escape.exec(value);
      if (m && m.index === at) {
        out += m[0];                     // an escape costs no columns and is copied whole
        at = escape.lastIndex;
        continue;
      }
      out += value[at];
      taken += 1;
      at += 1;
    }
    seen += cost;
  }
  // ANY TRAILING ESCAPES that sat immediately after the last kept grapheme come too: they cost
  // nothing and dropping a reset is how a clipped line tints everything below it.
  while (at < value.length) {
    escape.lastIndex = at;
    const m = escape.exec(value);
    if (!m || m.index !== at) break;
    out += m[0];
    at = escape.lastIndex;
  }
  // RESET AFTER A CUT, if anything was left open. A clipped line ending mid-colour tints every row
  // below it, the divider, and the pane beside it.
  return SGR_ONCE.test(out) ? `${out}${SGR_RESET}` : out;
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
