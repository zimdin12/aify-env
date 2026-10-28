// What the operator's terminal sent, as keys and pastes: the console session's input, before any of it means anything.
//
// It decides only HOW A READ IS CUT. What a key or a paste does is the session's: `key` and `paste` are its handlers,
// and `mode` is asked so a read in a mode that takes keys one at a time can be split.

import { DETACH } from "../keys.mjs";
import { isNavigationKey, splitKeys } from "../key-input.mjs";
import { PasteReader } from "../bracketed-paste.mjs";

//: The modes whose keys are handled one at a time. See `chunk`.
const KEY_AT_A_TIME_MODES = new Set(["dashboard", "menu", "start"]);

export class InputDecoder {
  //: WHICH BYTES ARE A PASTE, across reads. See `chunk`.
  #reader = new PasteReader({ release: DETACH });
  #key;
  #paste;
  #mode;

  /**
   * @param {{key: (data: string) => object, paste: (text: string) => object, mode: () => string}} handlers
   */
  constructor({ key, paste, mode }) {
    this.#key = key;
    this.#paste = paste;
    this.#mode = mode;
  }

  /**
   * Interpret one READ, which may carry several keys (v0.7 scan, F14).
   *
   * A READ MADE ONLY OF NAVIGATION KEYS IS SPLIT, on the list, the menu and the start list: a held arrow or a quick
   * `jj` arrives as one read on a busy daemon and used to do nothing. EVERY OTHER READ IS TAKEN WHOLE, as it always
   * was: the pane passes it to the process untouched, the picker reads it as text, a confirmation is answered only by
   * a chunk that is exactly `y`, and on the list a pasted word or line matches no key and does nothing. Splitting
   * those too let `ok` plus Enter move the selection and attach the keyboard to an agent the operator never chose
   * (v0.7 TUI review).
   *
   * A PASTE IS NEITHER (v0.7.1 review, T06): with bracketed paste on, whatever arrives between `CSI 200~` and
   * `CSI 201~` is one unit, however the terminal split it into reads.
   *
   * @returns {object[]} one result per key or paste handled
   */
  chunk(data) {
    return this.#pieces(this.#reader.read(String(data ?? "")));
  }

  /** Give up input held back for the rest of a paste marker, once the terminal has gone quiet. */
  flush() {
    return this.#pieces(this.#reader.flush());
  }

  /** Milliseconds until `flush` is due, or null when nothing is held. */
  get waitMs() {
    return this.#reader.waitMs;
  }

  #pieces(pieces) {
    return pieces.flatMap((piece) => (piece.paste ? [this.#paste(piece.text)] : this.#typed(piece.text)));
  }

  #typed(data) {
    const keys = splitKeys(data);
    if (keys.length > 1 && KEY_AT_A_TIME_MODES.has(this.#mode()) && keys.every(isNavigationKey)) {
      return keys.map((key) => this.#key(key));
    }
    return [this.#key(String(data ?? ""))];
  }
}
