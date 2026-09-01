// Reading the event stream `GET /processes/:id/output` writes.
//
// THE OTHER HALF OF THE CONSOLE. `pane-buffer.mjs` turns text into pane rows; this turns what arrives
// on the wire into that text, plus the one thing text cannot carry -- that the process has exited.
//
// THE WIRE FORMAT, from the server that writes it (bin/aify-env.mjs):
//
//     data: "one chunk, JSON-encoded"\n\n
//     event: exit\ndata: {"code":0}\n\n
//
// Chunks are JSON-encoded because a newline in a process's output would otherwise END THE FRAME --
// the blank line is the delimiter, and a coding agent emits newlines constantly. So the encoding is
// not decoration and a parser that split on newlines without decoding would cut every multi-line
// chunk in half at a boundary nobody chose.
//
// EXIT IS A NAMED EVENT for the same class of reason: a consumer reading `data:` frames as output
// would otherwise print `{"code":0}` as though the process had said it. Nothing distinguishes the two
// but the event name.
//
// PURE, WITH AN EXPLICIT CARRY, matching `splitChunk` next door. A socket splits frames wherever it
// likes -- mid-JSON, between the `event:` line and its `data:` line, inside the blank line itself --
// and the only way to test that honestly is to hand the carry back in by hand.

const LF = String.fromCharCode(10);
const FRAME_END = LF + LF;

/** A chunk the process printed. */
export const FRAME_OUTPUT = "output";
/** The process exited. Carries `code` (which may be null) and optionally `signal`. */
export const FRAME_EXIT = "exit";
/** A frame that arrived but could not be understood. Reported, never silently dropped. */
export const FRAME_UNREADABLE = "unreadable";

/**
 * Parse one complete frame's text into a typed frame, or null when it carries nothing.
 *
 * A FRAME THAT CANNOT BE READ IS REPORTED, not skipped. Dropping it would make a truncated or
 * re-encoded stream look like a quiet process, which is the same false-absence this codebase keeps
 * finding: the console would show nothing and nobody could tell whether that meant silence or a
 * broken feed.
 */
export function parseFrame(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;

  let event = FRAME_OUTPUT;
  let data = null;
  let sawData = false;

  for (const line of raw.split(LF)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || FRAME_OUTPUT;
    } else if (line.startsWith("data:")) {
      // MULTIPLE `data:` LINES CONCATENATE, per SSE. This server writes one, but a parser that
      // silently kept only the last would corrupt a longer frame rather than fail on it.
      data = (data === null ? "" : data + LF) + line.slice(5).replace(/^ /, "");
      sawData = true;
    }
    // Anything else (`id:`, `retry:`, a comment) is not part of this contract and is ignored.
  }

  if (!sawData) return null;

  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch {
    return { type: FRAME_UNREADABLE, why: "the data field was not valid JSON", raw };
  }

  if (event === FRAME_EXIT) {
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { type: FRAME_UNREADABLE, why: "an exit frame whose data was not an object", raw };
    }
    // `code` MAY BE NULL, and that is not a missing value -- it is what a signalled death looks like.
    // Coercing it to 0 would report a killed process as one that exited cleanly. `signal` is omitted
    // rather than sent empty, so its absence means "nothing killed it" rather than "killed by
    // something unnamed".
    const frame = { type: FRAME_EXIT, code: decoded.code ?? null };
    if (decoded.signal) frame.signal = decoded.signal;
    return frame;
  }

  if (typeof decoded !== "string") {
    return { type: FRAME_UNREADABLE, why: "an output frame whose data was not a string", raw };
  }
  return { type: FRAME_OUTPUT, text: decoded };
}

/**
 * Split arriving bytes into whole frames, keeping whatever is still mid-frame.
 *
 * @param {string} carry  the incomplete frame text so far
 * @param {string} chunk  newly arrived bytes, as text
 * @returns {{frames: object[], carry: string}}
 */
export function readFrames(carry, chunk) {
  const buffer = String(carry ?? "") + String(chunk ?? "");
  const parts = buffer.split(FRAME_END);
  // THE LAST PIECE IS NOT A FRAME. Without a trailing blank line it is a frame still arriving, and
  // parsing it now would decode half a JSON string -- or worse, succeed on a prefix that happens to
  // be valid. It goes back as the carry.
  const rest = parts.pop() ?? "";
  const frames = [];
  for (const part of parts) {
    const frame = parseFrame(part);
    if (frame) frames.push(frame);
  }
  return { frames, carry: rest };
}
