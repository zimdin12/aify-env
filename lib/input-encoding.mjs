// What the bytes on the input wire MEAN, said by the sender rather than guessed by the receiver.
//
// TWO KINDS OF CALLER POST TO THE SAME ROUTE, and they disagree about what a string is.
//
//   - `aify-env attach` has a raw stdin and must be byte-transparent: a keystroke is bytes, an escape
//     sequence is bytes, and a paste may not be text at all. It decodes them as latin1, which maps
//     each byte to one code unit and survives a multi-byte character split across two chunks.
//   - The dashboard console sends TEXT. Whatever the operator typed arrives as JSON, already decoded,
//     and the bytes it began life as are long gone.
//
// A receiver that treats both the same corrupts one of them. MEASURED against node-pty on this host,
// 2026-09-21, with the child reporting its own stdin in hex: typing `e-acute` through attach put
// `c3a9` on the wire and `c383c2a9` reached the process -- UTF-8 encoded twice, because the latin1
// string was handed to a writer that encodes UTF-8. `yen` gave `c382c2a5` the same way. ASCII is the
// control and was never affected, which is why this survived from the first attach commit.
//
// SO THE FRAME SAYS. An absent `encoding` means text, which is what every caller that predates this
// meant, so an older client keeps working exactly as before.

/** The encodings a caller may name, and what each one means the `data` string is. */
export const WIRE_ENCODINGS = Object.freeze({
  // A JS string of text. The writer encodes it however the process expects.
  utf8: null,
  // One code unit per byte: the string IS the bytes, and they are handed over unchanged.
  binary: "latin1",
});

/**
 * Turn a request body's `data` into what the runner should write.
 *
 * @returns {{ok: true, value: string|Buffer}|{ok: false, error: string}}
 */
export function inputPayload({ data, encoding } = {}) {
  if (typeof data !== "string") return { ok: false, error: "an input request must carry a string `data`" };
  if (encoding === undefined || encoding === null) return { ok: true, value: data };
  if (!Object.hasOwn(WIRE_ENCODINGS, encoding)) {
    return { ok: false, error: `unknown input encoding \`${encoding}\`; expected one of ${Object.keys(WIRE_ENCODINGS).join(", ")}` };
  }
  const decode = WIRE_ENCODINGS[encoding];
  return { ok: true, value: decode ? Buffer.from(data, decode) : data };
}
