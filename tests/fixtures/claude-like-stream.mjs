// A synthetic stream shaped like a coding agent's terminal output. Generated, never captured.
//
// What it exercises, because each is a way a checkpoint could be wrong: scrolling log lines, rows
// repainted in place with cursor addressing and erase-in-line, SGR colour and concealed text, wide
// characters, long rows that reflow on a resize, and escape sequences split across chunk boundaries
// the way a PTY read splits them.

const ESC = String.fromCharCode(27);

/** A small deterministic PRNG, so a failing run can be reproduced exactly. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * One logical frame, drawn the way an inline renderer draws: erase the live block it drew last time
 * with cursor-up and erase-line, print the new log lines above it, then draw the live block again.
 * Occasionally a long row is written at an absolute position, which reflows on a resize.
 */
function frame(n, random, rows) {
  let out = n > 0 ? `${ESC}[2K${ESC}[1A${ESC}[2K\r` : "";
  const logLines = 1 + Math.floor(random() * 3);
  for (let i = 0; i < logLines; i += 1) {
    out += `${ESC}[${32 + (n % 5)}mlog ${n}.${i}${ESC}[0m ${"x".repeat(Math.floor(random() * 50))} \u2502 \u4e2d\u6587 \u2728\r\n`;
  }
  if (random() < 0.2) {
    const row = 1 + Math.floor(random() * Math.max(1, rows - 3));
    out += `${ESC}[${row};1H${ESC}[K${"#".repeat(40 + Math.floor(random() * 30))}${ESC}[${rows};1H\r\n`;
  }
  out += `${ESC}[1mstatus ${n}${ESC}[22m ${ESC}[8mhidden${n}${ESC}[28m ${"=".repeat(Math.floor(random() * 30))}\r\n`;
  out += `${ESC}[7m> prompt ${n}${ESC}[27m`;
  return out;
}

/**
 * Chunks of about `size` characters, cut at arbitrary places -- including inside escape sequences.
 *
 * @returns {() => string} the next chunk each call
 */
export function claudeLikeChunks({ seed = 7, size = 256, rows = 12 } = {}) {
  const random = prng(seed);
  let pending = "";
  let n = 0;
  return () => {
    while (pending.length < size) pending += frame(n++, random, rows);
    let cut = Math.max(1, Math.floor(size * (0.5 + random())));
    // Never split a surrogate pair: the runner's decoder hands over whole characters.
    const code = pending.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut += 1;
    const chunk = pending.slice(0, cut);
    pending = pending.slice(cut);
    return chunk;
  };
}

export const ESCAPE = ESC;
