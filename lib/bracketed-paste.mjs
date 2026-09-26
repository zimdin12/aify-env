// Telling a paste from typing, across however many reads the terminal splits it into.
//
// THE DEFECT (v0.7.1 review, T06 and E9). The view guessed: a read holding more than one key was
// treated as a paste and left alone. A terminal splits a paste wherever it likes, so a piece that was
// exactly `\r` attached the keyboard and a piece of `j` and `k` moved the selection.
//
// BRACKETED PASTE (`CSI ?2004h`) makes the terminal say so: every paste arrives as
// `CSI 200~` ... `CSI 201~`. This reads a stream of chunks into typed runs and whole pastes, in order.
// A marker can itself be cut between two reads, so a tail that could be the start of one is held back
// until the next read shows what it was -- or until the terminal goes quiet, which the caller times.

const ESC = String.fromCharCode(27);

export const PASTE_START = `${ESC}[200~`;
export const PASTE_END = `${ESC}[201~`;

//: How long a held-back tail waits for the rest of a marker. A marker is written in one burst, so
//: this is the gap between two reads of one write -- and it is also how late a lone ESC typed into
//: an attached pane reaches the agent, which is why it is short.
export const PASTE_HOLD_MS = 50;

//: How long a paste may go without its end marker before it is closed as it stands. A terminal writes
//: a paste in one burst, so a paste this quiet has lost its end; without this, every key after it
//: would be swallowed as part of a paste that never ends.
export const PASTE_QUIET_MS = 500;

/** The length of the longest end of `text` that is a proper beginning of `marker`. */
function heldTail(text, marker) {
  for (let n = Math.min(text.length, marker.length - 1); n > 0; n -= 1) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/**
 * A stream of reads as typed runs and complete pastes.
 *
 * `read` returns `{paste, text}` pieces in order: `paste: false` for what was typed, `paste: true`
 * for one whole paste, its markers removed. `flush` gives up what is being held, once the caller's
 * timer says the terminal has gone quiet; `waitMs` says whether, and how soon, it should be called.
 */
export class PasteReader {
  #inPaste = false;
  #paste = "";
  #held = "";

  read(chunk) {
    let data = `${this.#held}${String(chunk ?? "")}`;
    this.#held = "";
    const pieces = [];
    const typed = (text) => {
      // A STRAY END MARKER IS DROPPED: it closes a paste this reader already gave up on.
      const clean = text.split(PASTE_END).join("");
      if (clean) pieces.push({ paste: false, text: clean });
    };
    while (data) {
      const marker = this.#inPaste ? PASTE_END : PASTE_START;
      const at = data.indexOf(marker);
      if (at < 0) {
        const keep = heldTail(data, marker);
        const settled = data.slice(0, data.length - keep);
        this.#held = data.slice(data.length - keep);
        if (this.#inPaste) this.#paste += settled;
        else typed(settled);
        break;
      }
      if (this.#inPaste) {
        pieces.push({ paste: true, text: `${this.#paste}${data.slice(0, at)}` });
        this.#paste = "";
      } else {
        typed(data.slice(0, at));
      }
      this.#inPaste = !this.#inPaste;
      data = data.slice(at + marker.length);
    }
    return pieces;
  }

  /** Milliseconds until `flush` is due, or null when nothing is held. */
  get waitMs() {
    if (this.#inPaste) return PASTE_QUIET_MS;
    return this.#held ? PASTE_HOLD_MS : null;
  }

  /** Give up what is held: a paste that lost its end, closed as it stands, or a tail that was typed. */
  flush() {
    const held = this.#held;
    this.#held = "";
    if (this.#inPaste) {
      const text = `${this.#paste}${held}`;
      this.#inPaste = false;
      this.#paste = "";
      return [{ paste: true, text }];
    }
    return held ? [{ paste: false, text: held }] : [];
  }
}
