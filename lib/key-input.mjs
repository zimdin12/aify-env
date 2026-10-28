// The keys a chunk of terminal input holds, and what it types (0.9.8, moved verbatim out of lib/keys.mjs).
//
// ITS OWN MODULE because more than the router needs it: lib/console-session.mjs splits every read with it before a
// key is routed, and the router reads the escape constants. No state and no routing here, only bytes to keys.

export const ESC = String.fromCharCode(27);
export const UP = `${ESC}[A`;
export const DOWN = `${ESC}[B`;
export const BACKSPACE = String.fromCharCode(127);

//: One key at the front of a chunk: a CSI sequence (`ESC [` ... final byte), an SS3 one (`ESC O x`),
//: an escape with one following character (Alt+key), a bare escape, or one code point.
const LEADING_KEY = /^(?:\x1b\[[0-?]*[ -\/]*[@-~]|\x1bO.|\x1b[\s\S]?|[\s\S])/u;

/**
 * What a chunk types into a search: its printable characters, up to the first escape.
 *
 * AN ESCAPE SEQUENCE IS DROPPED FROM WHEREVER IT STARTS. Filtering on "printable" alone removes the
 * ESC and keeps `[` and `C`, so a right arrow typed `[C` into the filter. A read that coalesces a
 * typed character with a following arrow -- ordinary on a daemon redrawing while streaming PTYs --
 * delivers `a<ESC>[C` as one chunk, so what precedes the first ESC is kept and the rest is dropped.
 * Printable only otherwise, because one chunk may be a paste of several characters.
 */
export function typedText(chunk) {
  const text = String(chunk ?? "");
  const escapeAt = text.indexOf(ESC);
  const typable = escapeAt >= 0 ? text.slice(0, escapeAt) : text;
  return [...typable].filter((ch) => ch >= " " && ch !== BACKSPACE).join("");
}

/**
 * Whether a key only moves a cursor. A read made only of these is split and each key handled; any
 * other read is taken whole, so a paste on the list stays inert (v0.7 TUI review: `ok` plus Enter,
 * split, moved the selection and attached the keyboard to another agent).
 */
export function isNavigationKey(key) {
  return key === UP || key === DOWN || key === "j" || key === "k";
}

/**
 * A chunk as the keys it holds, in order (v0.7 scan, F14).
 *
 * A READ IS NOT A KEY, and outside the pane that used to mean a held arrow or a quick `jj` that
 * arrived in one read did nothing at all, because routing compared the whole chunk against one key.
 * Escape sequences stay whole, and everything else is split by CODE POINT so a character outside the
 * BMP is not cut in half.
 */
export function splitKeys(chunk) {
  const keys = [];
  let rest = String(chunk ?? "");
  while (rest) {
    const [key] = rest.match(LEADING_KEY);
    keys.push(key);
    rest = rest.slice(key.length);
  }
  return keys;
}
