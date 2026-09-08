// Turning a cell's appearance back into the escape sequence that produced it.
//
// A SCREEN WITHOUT COLOUR IS READABLE AND WRONG. Coding agents use colour to say things text does not
// -- red for a failure, dim for what has already scrolled past, inverse for the selected item -- and a
// pane that flattens all of it shows the operator a picture with its emphasis removed. Text-first was
// the right thing to ship first; this is the rest of it.
//
// EMITTED ON CHANGE, NEVER PER CELL. A 132-column row where every cell carries its own SGR run is
// several kilobytes of escapes for 132 visible characters, redrawn every refresh, per pane. So this
// compares each cell to the one before it and writes only the difference -- which is exactly what the
// process itself did on the way in.
//
// PURE, AND SEPARATE FROM THE CELL API. `styleFrom` is the only function here that touches xterm's
// shape; everything below it works on a plain object, so the encoding rules are testable with
// literals on a machine where the emulator was never installed.

const ESC = String.fromCharCode(27);

/** Back to the terminal's defaults. Emitted at the end of any row that changed anything. */
export const RESET = `${ESC}[0m`;

/** How a colour was specified, which decides how it must be written back. */
export const DEFAULT = "default";
export const PALETTE = "palette";
export const RGB = "rgb";

//: What a cell with no styling looks like. Frozen because it is compared against, never mutated.
export const PLAIN = Object.freeze({
  fg: Object.freeze({ kind: DEFAULT, value: 0 }),
  bg: Object.freeze({ kind: DEFAULT, value: 0 }),
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
});

function colourOf(cell, side) {
  const isDefault = side === "fg" ? cell.isFgDefault?.() : cell.isBgDefault?.();
  if (isDefault) return { kind: DEFAULT, value: 0 };
  const isRGB = side === "fg" ? cell.isFgRGB?.() : cell.isBgRGB?.();
  const value = side === "fg" ? cell.getFgColor?.() : cell.getBgColor?.();
  return { kind: isRGB ? RGB : PALETTE, value: Number(value) || 0 };
}

/**
 * One cell's appearance, as a plain object.
 *
 * THE ONLY FUNCTION HERE THAT KNOWS ABOUT xterm, and every predicate is called defensively because a
 * cell object is what a third-party package hands back: a version that dropped one of these would
 * otherwise take the whole view down rather than lose an attribute.
 *
 * `isBold()` AND FRIENDS RETURN BIT FLAGS, NOT BOOLEANS -- measured, bold came back as 134217728. A
 * strict `=== true` would therefore find no styling anywhere and this whole module would render
 * nothing, silently and while looking correct.
 */
export function styleFrom(cell) {
  if (!cell) return PLAIN;
  return {
    fg: colourOf(cell, "fg"),
    bg: colourOf(cell, "bg"),
    bold: Boolean(cell.isBold?.()),
    dim: Boolean(cell.isDim?.()),
    italic: Boolean(cell.isItalic?.()),
    underline: Boolean(cell.isUnderline?.()),
    inverse: Boolean(cell.isInverse?.()),
  };
}

/** Whether two styles would render identically, so an unchanged run emits nothing. */
export function sameStyle(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.fg.kind === b.fg.kind && a.fg.value === b.fg.value
    && a.bg.kind === b.bg.kind && a.bg.value === b.bg.value
    && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic
    && a.underline === b.underline && a.inverse === b.inverse;
}

function colourParams(colour, side) {
  const base = side === "fg" ? 30 : 40;
  if (colour.kind === DEFAULT) return [base + 9];
  if (colour.kind === RGB) {
    // PACKED 24-BIT, unpacked here rather than carried as three fields, because that is the shape the
    // cell API hands over: 660510 is 0x0A141E, which is rgb(10, 20, 30).
    const value = colour.value >>> 0;
    return [base + 8, 2, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }
  // THE FIRST SIXTEEN HAVE SHORT FORMS AND THE REST DO NOT. Writing `38;5;n` for all of them is
  // correct and longer; writing the short form for the low sixteen matches what the process sent and
  // keeps the common case small, which matters when this is re-emitted on every refresh.
  const index = colour.value;
  if (index < 8) return [base + index];
  if (index < 16) return [base + 60 + (index - 8)];
  return [base + 8, 5, index];
}

/**
 * The escape that turns `previous` into `next`, or "" when nothing changed.
 *
 * A FULL RESTATEMENT RATHER THAN A DIFF OF ATTRIBUTES, once anything changes. Turning bold OFF needs
 * `22`, which is a different code from the `1` that turned it on, and a rule per attribute per
 * direction is a table nobody can check. Emitting `0` and then the whole style is one rule, and it is
 * what makes `sameStyle` the only thing that has to be right.
 */
export function sgrBetween(previous, next) {
  if (sameStyle(previous, next)) return "";
  if (sameStyle(next, PLAIN)) return RESET;
  const params = [0];
  if (next.bold) params.push(1);
  if (next.dim) params.push(2);
  if (next.italic) params.push(3);
  if (next.underline) params.push(4);
  if (next.inverse) params.push(7);
  params.push(...colourParams(next.fg, "fg"));
  params.push(...colourParams(next.bg, "bg"));
  return `${ESC}[${params.join(";")}m`;
}
