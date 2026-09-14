// The daemon's own copy of each PTY's screen, so a late subscriber can be handed the screen itself.
//
// WHY. The runner keeps a capped suffix of output, and a suffix cannot rebuild a positioned screen
// (`screen-baseline.mjs` says why at length). For an agent that has printed more than the cap, a new
// console could only wait for a RIS that Claude never sends. This keeps a headless emulator per PTY,
// fed every chunk and every resize in order, and serializes it for a subscriber that joins: a screen
// that is sound by construction, followed by exactly the live bytes after it.
//
// THE HARD PART IS THE POSITION. xterm's `write` parses later, in timer slices, so at the moment a
// subscriber joins the emulator is some bytes behind the stream. A snapshot taken then describes a
// screen from the past, and the live bytes after it would repeat what it already shows. So every
// operation -- a chunk, a resize, a snapshot -- goes through the same write queue, and xterm calls a
// write's callback synchronously right after that chunk is parsed and before the next one starts
// (WriteBuffer._innerWrite in 5.5.0). A snapshot taken inside its callback is the screen after exactly
// the operations queued before it, and the caller learns that position as `at` and `resizes`.
//
// AND IT MUST BE A CLEAN BOUNDARY. A PTY read can end in the middle of an escape sequence. The
// daemon's parser carries that state into the next chunk; a fresh subscriber's parser does not, and
// would print the rest of the sequence as text. So a snapshot is only taken where the parser is in
// its ground state with no half surrogate pending, and otherwise waits for the next chunk boundary.
// Those two facts are private fields of the pinned 5.5.0 package; if they are not where expected the
// checkpoint declines every snapshot and subscribers get today's replay.
//
// NOT CARRIED by the serializer, and so not reconstructed for a late subscriber: scroll margins
// (DECSTBM), a saved cursor (DECSC), cursor visibility and character sets. Claude Code's inline
// renderer uses none of them for what it draws.
//
// OPTIONAL, all three packages. With any one missing `loadCheckpointFactory` resolves null and the
// runner behaves exactly as it did before this file existed.

import { loadEmulator, ScreenEmulator } from "./screen-emulator.mjs";

const SERIALIZE_PACKAGE = "@xterm/addon-serialize";

//: How long a snapshot may wait for a clean boundary. A process that stops mid-sequence and goes
//: quiet would otherwise hold a subscriber with no meta and no bytes; after this it gets the replay.
const BOUNDARY_WAIT_MS = 1000;

let loading = null;

/**
 * A function building one checkpoint per PTY, or null when any of the three packages is absent.
 *
 * UNICODE 11 IS REQUIRED HERE, where the pane only prefers it. A checkpoint is presented as the
 * truth; built with the wrong character widths it would put every cell after an emoji one column off
 * and still claim to be sound.
 */
export function loadCheckpointFactory() {
  loading ??= (async () => {
    const emulator = await loadEmulator();
    if (!emulator?.Unicode11Addon) return null;
    let SerializeAddon;
    try {
      const addon = await import(SERIALIZE_PACKAGE);
      SerializeAddon = addon?.default?.SerializeAddon ?? addon?.SerializeAddon;
    } catch {
      return null;
    }
    if (typeof SerializeAddon !== "function") return null;
    return (geometry) => new ScreenCheckpoint({ ...emulator, SerializeAddon }, geometry);
  })();
  return loading;
}

class ScreenCheckpoint {
  #serializer;
  #fed = 0;
  #parsed = 0;
  #resizes = 0;
  //: Snapshots queued or waiting for a boundary, so disposal can answer every one of them.
  #open = new Set();
  #waiting = [];

  constructor({ Terminal, Unicode11Addon, SerializeAddon }, { cols, rows }) {
    //: The same emulator the pane uses, so widths and cell reading agree by construction.
    //: Scrollback 0: this exists to answer what is on screen now.
    this.screen = new ScreenEmulator({ Terminal, Unicode11Addon }, { cols, rows });
    this.#serializer = new SerializeAddon();
    this.screen.term.loadAddon(this.#serializer);
    const handler = this.screen.term._core?._inputHandler;
    this.usable = typeof handler?._parser?.currentState === "number"
      && typeof handler?._stringDecoder?._interim === "number";
  }

  /** Bytes fed but not yet parsed. */
  get lag() {
    return this.#fed - this.#parsed;
  }

  /** Feed one chunk, in order with everything else. */
  feed(text) {
    if (this.screen.disposed || !text) return;
    this.#fed += text.length;
    this.#enqueue(text, () => {
      this.#parsed += text.length;
      this.#retry();
    });
  }

  /** Resize in order with the bytes. `term.resize` is immediate and `write` is not, so it queues. */
  resize(cols, rows) {
    this.#enqueue("", () => {
      this.screen.resize({ cols, rows });
      this.#resizes += 1;
    });
  }

  /**
   * The screen after every operation queued so far, or null when one cannot be given.
   *
   * @returns {Promise<{data: string, cols: number, rows: number, at: number, resizes: number}|null>}
   *   `at` counts the characters fed before it and `resizes` the resizes applied before it, so a
   *   caller can tell exactly which live events the snapshot already includes.
   */
  snapshot() {
    if (this.screen.disposed || !this.usable) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      this.#open.add(waiter);
      this.#enqueue("", () => {
        if (this.#take(waiter)) return;
        waiter.timer = setTimeout(() => this.#settle(waiter, null), BOUNDARY_WAIT_MS);
        waiter.timer.unref?.();
        this.#waiting.push(waiter);
      });
    });
  }

  /** Let go. Every snapshot still waiting is answered with null. */
  dispose() {
    for (const waiter of this.#open) this.#settle(waiter, null);
    this.#waiting = [];
    this.screen.dispose();
  }

  #enqueue(text, then) {
    try {
      this.screen.term.write(text, () => {
        if (!this.screen.disposed) then();
      });
    } catch {
      // xterm refuses writes past 50 MB of unparsed data. A checkpoint that fell that far behind
      // cannot be trusted to catch up, so it stops being one.
      this.dispose();
    }
  }

  #atBoundary() {
    const handler = this.screen.term._core._inputHandler;
    return handler._parser.currentState === 0 && handler._stringDecoder._interim === 0;
  }

  /** Take the snapshot now if this is a clean boundary. Runs only inside a write callback. */
  #take(waiter) {
    if (!this.#atBoundary()) return false;
    let data;
    try {
      data = this.#serializer.serialize({ scrollback: 0 });
    } catch {
      data = null;
    }
    const { cols, rows } = this.screen.term;
    this.#settle(waiter, data === null ? null : { data, cols, rows, at: this.#parsed, resizes: this.#resizes });
    return true;
  }

  #retry() {
    if (!this.#waiting.length) return;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const waiter of waiting) {
      if (!this.#open.has(waiter)) continue;
      if (!this.#take(waiter)) this.#waiting.push(waiter);
    }
  }

  #settle(waiter, value) {
    if (!this.#open.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }
}
