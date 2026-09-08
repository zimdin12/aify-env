// The event stream `GET /processes/:id/output` writes: BOTH ENDS OF IT.
//
// WRITING AND READING LIVE TOGETHER because they are one format, and until 2026-09-08 only the
// reading half was here -- while this file's own header described, in prose, what the other half
// emitted. That is two copies of one fact with a route in between, and the copy in prose is the one
// that rots. Now the encoder and the decoder are neighbours and a round-trip test holds them to each
// other, so a change to the format cannot pass by editing only the side somebody was looking at.
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
/**
 * What the producer is, told BEFORE the replay: `cols`, `rows`, `truncated`, `replayBytes`.
 *
 * A SCREEN NEEDS THESE AND CANNOT INFER THEM. Geometry decides where every wrapped row lands, and
 * `truncated` says whether the replay that follows is a complete history or a suffix whose head --
 * positioned text, SGR state, mode changes -- is gone and unrecoverable.
 */
export const FRAME_META = "meta";
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

  if (event === FRAME_META) {
    // AN OBJECT, LIKE `exit` AND UNLIKE OUTPUT. Adding the writer without teaching the reader made
    // every stream open with an `unreadable` frame -- the writer emitted something the parser
    // rejected, and unreadable frames are REPORTED, so a console would have led with an error on
    // every attach. A field is not shipped until both ends are proven; the round-trip test that
    // should have caught this checked the frame's PREFIX and never fed it back through here.
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { type: FRAME_UNREADABLE, why: "a meta frame whose data was not an object", raw };
    }
    // NUMBERS, COERCED ONCE, HERE. A consumer sizing an emulator from a string would build a
    // one-column screen and paint every row into it. Zero is a real answer -- a piped process has no
    // terminal and therefore no size -- so it is kept rather than defaulted away.
    return {
      type: FRAME_META,
      cols: Number(decoded.cols) || 0,
      rows: Number(decoded.rows) || 0,
      // FAILS CLOSED. A frame that does not SAY whether its replay is complete must not be read as
      // saying it is: `truncated` absent, a string, or null all become TRUE here, because "we were
      // not told" and "the history is whole" are opposite answers and only one of them is safe to
      // guess. Coercing to `false` was the bug -- it turned silence into a completeness claim, and a
      // consumer would then show a reconstruction as authoritative on the strength of a missing
      // field.
      truncated: typeof decoded.truncated === "boolean" ? decoded.truncated : true,
      replayBytes: Number(decoded.replayBytes) || 0,
    };
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

// -- WRITING, for `bin/aify-env.mjs` -----------------------------------------------------------

/**
 * One `data:` frame carrying arbitrary text.
 *
 * JSON-ENCODED, AND THAT IS LOAD-BEARING RATHER THAN TIDY. A newline is the frame delimiter here, so
 * writing raw output would end the event early and split one chunk into two frames -- and a process
 * that printed a blank line would emit a frame terminator in the middle of its own output. Encoding
 * makes every byte the process produced survive as one frame.
 */
export function dataFrame(text) {
  return "data: " + JSON.stringify(String(text ?? "")) + FRAME_END;
}

/**
 * A NAMED frame, which is how this protocol adds facts without breaking the consumers it has.
 *
 * A reader that only handles `data:` lines as output IGNORES a named event entirely, so a new kind of
 * information can arrive on an existing stream and older consumers see exactly the stream they always
 * saw. That is the compatibility argument `exit` was added under, and the one `meta` is added under.
 */
export function namedFrame(name, payload) {
  return "event: " + String(name) + LF + "data: " + JSON.stringify(payload) + FRAME_END;
}

/**
 * The frame that says a process is gone.
 *
 * TWO FIELDS, because one could not say what happened. `code` may be NULL -- that is what a signalled
 * death looks like, and it used to be coerced to 0 before it ever reached the wire, so a consumer
 * recorded "exited with code 0" for a worker something had killed. A 0 reads as evidence, which made
 * it worse than the silence it replaced.
 *
 * `signal` is OMITTED rather than sent empty, so a consumer can tell "nothing killed it" from "killed
 * by something I have no name for" -- and so an older consumer reading only `code` sees a frame the
 * same shape it always saw.
 */
export function exitFrame(code, signal) {
  const payload = signal ? { code, signal } : { code };
  return namedFrame("exit", payload);
}
