/**
 * The LAST terminal title in a chunk of output, or null when it contains none.
 *
 * OSC 0 and OSC 2 both set a window title and both end with BEL or ST. Kept small and pure: it runs on
 * every byte a process emits, so it must not allocate a parser or throw on half a sequence -- a title
 * split across two chunks is simply missed, and the next one arrives soon enough.
 */
export function lastTerminalTitle(text) {
  // Scanned rather than matched. A regex for this needs an escape, a bracket and two terminators, and
  // building one through three layers of quoting produced `Unterminated group` twice; this cannot be
  // broken that way and is easier to read besides.
  const ESCAPE = String.fromCharCode(27);
  const BELL = String.fromCharCode(7);
  const value = String(text ?? "");
  let found = null;
  for (const opener of [`${ESCAPE}]0;`, `${ESCAPE}]2;`]) {
    let at = value.indexOf(opener);
    while (at !== -1) {
      const from = at + opener.length;
      // Either terminator ends it; whichever comes first wins. A sequence split across chunks has
      // neither, and is simply skipped -- the next title arrives soon enough.
      const bell = value.indexOf(BELL, from);
      const st = value.indexOf(`${ESCAPE}${String.fromCharCode(92)}`, from);
      const ends = [bell, st].filter((i) => i !== -1);
      if (ends.length) found = value.slice(from, Math.min(...ends));
      at = value.indexOf(opener, from);
    }
  }
  return found;
}
