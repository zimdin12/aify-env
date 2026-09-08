// Whether a byte stream has told the terminal to HIDE text.
//
// WHY A LINE MODEL CANNOT ANSWER THIS FOR ITSELF, which is the finding that produced this file.
//
// `pane-buffer.mjs` models a log: newline ends a line, carriage return moves the cursor to column 0
// and what follows OVERWRITES. That is correct for text and wrong for escapes, because an escape
// sequence occupies ZERO columns on a real terminal and one column per byte in that model. So
// `ESC[8m` + CR + `SYNTHETIC_HIDDEN` overwrites the escape with the first five letters and retains
// the line `SYNTHETIC_HIDDEN` -- while a real terminal, measured against @xterm/headless 5.5.0 on
// 2026-09-08, shows four BLANK rows.
//
// The disclosure is the point: the buffer's own bytes no longer contain the conceal, so no amount of
// scanning what it RETAINED can find it. The question has to be asked of the stream on the way in,
// before the column model destroys the evidence.
//
// THIS IS THE THIRD CONCEAL DISCLOSURE IN THIS FEATURE, and the first two were narrower: an `ESC[2J`
// accepted as a full reset, and the log path bypassing the baseline gate. Both were about a
// TRUNCATED history. This one has a complete history, no truncation, no cursor commands, and a
// `truncated: false` the daemon reported honestly -- so every gate written for the first two passes
// it. Completeness certifies that the bytes are all there; it certifies nothing about whether a line
// model can render them.
//
// SGR 8 IS THE MECHANISM, and naming it is a limit worth stating rather than hiding. It is the ECMA-48
// attribute whose whole job is to make text invisible while leaving it in the buffer, and it is what
// every conceal witness in this project has used. Text hidden some other way -- a foreground colour
// equal to the background -- is not detectable from the escape stream at all, and this does not claim
// to catch it.

const ESC = String.fromCharCode(27);

//: How much of an unterminated escape is worth carrying between chunks. A CSI sequence is
//: introducer plus parameters plus one final byte; a legitimate SGR is a handful of characters and
//: even an absurd one is far under this. Bounded so a stream of lone ESC bytes cannot grow it.
const MAX_PENDING = 64;

/**
 * Does this text contain an SGR that conceals?
 *
 * @param {string} text
 * @param {string} [pending] an unterminated escape left over from the previous chunk
 * @returns {{conceals: boolean, pending: string}} `pending` to pass to the next call
 */
export function scanForConceal(text, pending = "") {
  const stream = `${String(pending || "")}${String(text ?? "")}`;
  let conceals = false;
  let at = 0;
  let carried = "";
  while (at < stream.length) {
    const start = stream.indexOf(ESC, at);
    if (start === -1) break;
    // CSI ONLY. `ESC` followed by anything else is a two-character sequence or an introducer this
    // does not judge; either way it is not an SGR and cannot conceal.
    if (start + 1 >= stream.length) { carried = stream.slice(start); break; }
    if (stream[start + 1] !== "[") { at = start + 2; continue; }
    // The final byte of a CSI sequence is in the range @ to ~. Everything before it is parameters
    // and intermediates.
    let end = start + 2;
    while (end < stream.length && !isFinalByte(stream[end])) end += 1;
    if (end >= stream.length) { carried = stream.slice(start); break; }
    if (stream[end] === "m" && sgrConceals(stream.slice(start + 2, end))) conceals = true;
    at = end + 1;
  }
  return { conceals, pending: carried.length > MAX_PENDING ? "" : carried };
}

/** CSI sequences end on a byte in the range 0x40-0x7E. */
function isFinalByte(ch) {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Do these SGR parameters include conceal?
 *
 * SUB-PARAMETERS ARE NOT PARAMETERS, and that distinction is the whole of the false-positive risk.
 * `ESC[38:5:8m` selects palette colour 8 -- an ordinary grey -- and a scan that split on `;` alone
 * and looked for "8" would call it a conceal and refuse every pane that used that colour. Only the
 * value BEFORE the first `:` in each `;`-separated group is the parameter.
 *
 * A PRIVATE SEQUENCE IS NOT AN SGR. `ESC[?8m` is a private-mode form; `?`, `<`, `=` and `>` in the
 * leading position mean this is not the attribute stream and nothing in it should be read as one.
 */
function sgrConceals(parameters) {
  if (/^[?<=>]/.test(parameters)) return false;
  for (const group of parameters.split(";")) {
    const parameter = group.split(":")[0].trim();
    // AN EMPTY PARAMETER IS ZERO (a reset), never a match, and leading zeros are legal: `08` is 8.
    if (parameter !== "" && /^[0-9]+$/.test(parameter) && Number(parameter) === 8) return true;
  }
  return false;
}
