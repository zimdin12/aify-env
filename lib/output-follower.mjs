// Watching one process's console, from the client side.
//
// THE THREE PIECES MEET HERE. `sse-frames.mjs` reads the wire, `pane-buffer.mjs` holds what the
// process printed, and this connects them to a live HTTP stream and gives a renderer something to
// ask. It is the only part of the console that does IO, which is why everything else could be tested
// by calling it and this one takes an injectable `fetchImpl` -- the same seam `knock` already uses.
//
// WHY A STATUS AND NOT JUST LINES. A pane showing nothing has four completely different causes, and
// an operator needs them told apart:
//
//   connecting  the request is in flight; nothing is known yet
//   streaming   connected, and the process simply has not printed
//   exited      the process ended, and the exit frame says how
//   gone        404: the daemon has no such process
//   failed      the connection could not be made or died mid-stream
//
// Rendering all five as an empty pane is the failure this whole file exists to avoid: `runner.js`
// goes to the trouble of distinguishing "no such process" from "a process that has produced nothing
// yet", and a client that collapses them throws that away at the last step.

import { FRAME_EXIT, FRAME_META, FRAME_OUTPUT, FRAME_UNREADABLE, readFrames } from "./sse-frames.mjs";
import { baselineIsSound, baselineProblem, hasFullRepaint } from "./screen-baseline.mjs";
import { ScreenEmulator } from "./screen-emulator.mjs";
import { PaneBuffer } from "./pane-buffer.mjs";

export const CONNECTING = "connecting";
export const STREAMING = "streaming";
export const EXITED = "exited";
export const GONE = "gone";
export const FAILED = "failed";

/**
 * Apply one parsed frame, and say whether the stream is finished.
 *
 * PURE over the buffer it is handed, so every rule about what a frame DOES is testable without a
 * socket. The follower below is then thin enough to be mostly connection handling.
 *
 * @returns {{done: boolean, exit: object|null, unreadable: number, meta: object|null}}
 */
export function applyFrame(buffer, frame) {
  if (!frame) return { done: false, exit: null, unreadable: 0, meta: null };
  if (frame.type === FRAME_META) {
    // HANDED UP, NOT APPENDED. It describes the stream rather than being part of it, and a buffer
    // that appended it would print the producer's geometry into the operator's console.
    //
    // BEFORE THE REPLAY, which is the whole point: the bytes that follow cannot be turned into a
    // screen without knowing the width they were painted at, or whether their history is complete.
    // A consumer that learned this afterwards would already have built a screen at the wrong size.
    return { done: false, exit: null, unreadable: 0, meta: frame };
  }
  if (frame.type === FRAME_OUTPUT) {
    buffer.append(frame.text);
    return { done: false, exit: null, unreadable: 0, meta: null };
  }
  if (frame.type === FRAME_EXIT) {
    // DONE. The server ends the stream after this, and a console left waiting on a dead process makes
    // it look like a thinking one -- the failure the named exit event exists to prevent.
    const exit = { code: frame.code ?? null };
    if (frame.signal) exit.signal = frame.signal;
    return { done: true, exit, unreadable: 0, meta: null };
  }
  if (frame.type === FRAME_UNREADABLE) {
    // COUNTED, NOT PRINTED. Writing the raw frame into the pane would show an operator a protocol
    // error as though the process had said it -- the same confusion the named exit event avoids. But
    // it is not dropped either: a stream producing garbage is a fact about the feed, and the count is
    // what lets a view say so instead of looking quiet.
    return { done: false, exit: null, unreadable: 1, meta: null };
  }
  return { done: false, exit: null, unreadable: 0, meta: null };
}

/**
 * A live view of one process's output.
 *
 * NOTHING HERE THROWS AT THE RENDER LOOP. A dashboard's usual reason to be open is watching for the
 * moment something comes back, so a follower that rejected on a dropped connection would take the
 * whole screen down at exactly the moment it was needed. Failure becomes a status and a reason.
 */
export class OutputFollower {
  constructor({ endpoint, id, buffer = null, fetchImpl = fetch, maxLines = undefined } = {}) {
    this.endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.id = String(id || "");
    this.buffer = buffer || new PaneBuffer(maxLines ? { maxLines } : {});
    this.fetchImpl = fetchImpl;
    this.status = CONNECTING;
    this.exit = null;
    this.reason = null;
    this.unreadableFrames = 0;
    //: What the producer said it is, once the `meta` frame arrives. NULL until then -- and null
    //: is a real answer, meaning a daemon too old to send one, which a consumer must be able to
    //: tell from "a terminal 0 columns wide".
    this.meta = null;
    //: The emulated screen, or null. THIS FOLLOWER OWNS ITS LIFETIME, and that is what makes the
    //: operator's "only when the console is shown" true for the emulator as well: a follower exists
    //: only while the pane is shown (`console-session.mjs` opens one on show and closes it on hide or
    //: switch), so there is no separate gate to remember and no way for one to outlive its pane.
    this.screen = null;
    //: Whether a FULL REPAINT has arrived since this screen was created. It is what rescues a
    //: truncated replay: once a process throws its picture away and draws it again, whatever fell off
    //: the front stops bearing on what is displayed. See `screen-baseline.mjs`.
    this.repaintedSince = false;
    //: The last byte of the previous chunk, so a two-byte reset split across frames is still seen.
    this.repaintCarry = "";
    //: Set by `stop()`. A screen still loading when the pane closes is disposed on arrival.
    this.stopped = false;
    this.screenOpening = false;
    this.pendingPaint = [];
    this.controller = null;
    this.carry = "";
  }

  /** Where this follower reads from. Built once so a test can assert the URL without a server. */
  get url() {
    return `${this.endpoint}/processes/${encodeURIComponent(this.id)}/output`;
  }

  /**
   * Connect and read until the process exits, the stream ends, or `stop()` is called.
   *
   * Resolves rather than rejects, always. The outcome is in `status`.
   */
  async start() {
    this.controller = new AbortController();
    let response;
    try {
      response = await this.fetchImpl(this.url, { signal: this.controller.signal });
    } catch (error) {
      return this.#fail(error);
    }

    if (response.status === 404) {
      // NOT AN ERROR AND NOT AN EMPTY CONSOLE. The daemon is answering; it has no such process.
      this.status = GONE;
      this.reason = `no such process: ${this.id}`;
      return this;
    }
    if (!response.ok) {
      this.status = FAILED;
      this.reason = `the daemon answered ${response.status}`;
      return this;
    }
    if (!response.body) {
      this.status = FAILED;
      this.reason = "the daemon answered without a body to read";
      return this;
    }

    this.status = STREAMING;
    try {
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        // `stream: true` because a multi-byte character can be split across chunks, and a decoder
        // told each chunk is complete emits a replacement character in the middle of a word.
        if (this.#consume(decoder.decode(chunk, { stream: true }))) return this;
      }
      // The stream ended without an exit frame: the connection closed rather than the process
      // finishing. Those are different and the status says which.
      if (this.status === STREAMING) {
        this.status = FAILED;
        this.reason = "the stream ended without an exit";
      }
    } catch (error) {
      return this.#fail(error);
    }
    return this;
  }

  /**
   * Start an emulated screen for this stream, if one can be had.
   *
   * ASYNC AND NOT AWAITED, deliberately: `#consume` runs inside the read loop and blocking it on a
   * dynamic import would stall the very stream the screen is for. Bytes that arrive before the
   * emulator is ready are kept and replayed into it, so nothing is lost by starting late -- which is
   * also what makes the optional dependency survivable, since "never ready" is just the case where
   * the replay never happens.
   */
  #openScreen(meta) {
    if (this.screen || this.screenOpening) return;
    this.screenOpening = true;
    //: What arrived while the emulator was being loaded. Replayed in order, then dropped.
    this.pendingPaint = this.pendingPaint || [];
    ScreenEmulator.create({ cols: meta.cols, rows: meta.rows })
      .then((screen) => {
        this.screenOpening = false;
        // STOPPED WHILE WE WERE LOADING is the ordinary case, not an edge one: an operator can hide a
        // pane inside the same second they opened it. Disposing here rather than storing it is what
        // stops a screen outliving the pane that asked for it.
        if (!screen) return;
        if (this.stopped) { screen.dispose(); return; }
        // THE GEOMETRY MAY HAVE MOVED WHILE THIS WAS LOADING, and that is not an edge case: the
        // import is async, a resize is a `meta` frame like any other, and the branch that follows a
        // resize needs `this.screen` to already exist. So the size is re-read HERE, from the latest
        // meta rather than from the one this call was started with -- otherwise the screen is born at
        // a width the producer has already left, and every row wraps in the wrong place.
        if (this.meta && (this.meta.cols !== meta.cols || this.meta.rows !== meta.rows)) {
          screen.resize({ cols: this.meta.cols, rows: this.meta.rows });
        }
        this.screen = screen;
        const pending = this.pendingPaint;
        this.pendingPaint = [];
        for (const held of pending) this.#paint(held.text, held.repaints);
      })
      .catch(() => { this.screenOpening = false; });
  }

  /** Feed one chunk of output to the screen, and notice whether it repaints. */
  #paint(text, seen = null) {
    // JUDGED EXACTLY ONCE PER CHUNK, and `seen` is what guarantees it. Bytes that arrive before the
    // emulator has loaded are held and replayed through here a second time -- so computing the verdict
    // both times ran the carry over the same bytes twice, which can both invent a reset across a
    // boundary that never existed and miss one that did. The first pass decides; the replay carries
    // its answer.
    //
    // ACROSS THE CHUNK BOUNDARY, because `ESC c` is two bytes and a socket splits wherever it likes.
    // A detector judging each chunk alone misses a reset delivered as `ESC` then `c`, and the cost is
    // a console that stays unsound for ever -- the harmless direction, and still a screen the
    // operator never gets.
    let repaints = seen;
    if (repaints === null) {
      repaints = hasFullRepaint(this.repaintCarry + text);
      //: One byte is enough for the only sequence that counts. A longer carry would be storing stream
      //: content to answer a question this narrow.
      this.repaintCarry = text.slice(-1);
    }

    if (!this.screen) {
      if (this.screenOpening) this.pendingPaint.push({ text, repaints });
      return;
    }
    // THE FLAG IS SET WHEN THE PARSER HAS APPLIED IT, NOT WHEN THE BYTES ARRIVED. `write` is
    // asynchronous, so setting it here would declare the screen sound while the buffer still holds
    // the PRE-RESET picture -- review read exactly that: `lines()` published pre-reset content as
    // trustworthy, and it became correct only after the write completed. The two-second redraw is not
    // a synchronisation guarantee, it is a coincidence that usually holds.
    //
    // The promise is otherwise dropped because a rejected write must not take the stream down -- the
    // screen degrades, the log does not.
    this.screen.write(text).then((applied) => {
      if (applied && repaints) this.repaintedSince = true;
    }).catch(() => {});
  }

  /** Feed arrived text. Returns true when the stream is finished. */
  #consume(text) {
    const { frames, carry } = readFrames(this.carry, text);
    this.carry = carry;
    for (const frame of frames) {
      const result = applyFrame(this.buffer, frame);
      this.unreadableFrames += result.unreadable;
      // KEPT, so the pane can ask what it is looking at. The producer's geometry decides where every
      // wrapped row lands, and `truncated` decides whether a reconstructed screen can be trusted at
      // all -- neither is inferable from the bytes that follow, and both arrive exactly once, first.
      if (result.meta) {
        // A LATER `meta` IS A RESIZE. The producer re-announces its geometry when the pty changes
        // size, and a screen built at the old width renders every row after it in the wrong place --
        // identical bytes wrap differently at a different width, so this is not cosmetic drift.
        //
        // `ScreenEmulator.resize` HAD NO PRODUCTION CALLER until this line, which review pointed out:
        // a method nothing invokes is a claim the code does not make. It has one now.
        if (this.screen && this.meta
          && (this.meta.cols !== result.meta.cols || this.meta.rows !== result.meta.rows)) {
          this.screen.resize({ cols: result.meta.cols, rows: result.meta.rows });
        }
        this.meta = result.meta;
        // BUILT AT THE PRODUCER'S SIZE, the moment it is known and never before. Guessing a width and
        // resizing later is not a smaller error than guessing and keeping it: the bytes already
        // parsed would have wrapped at the wrong column, and a resize reflows that wrongness rather
        // than undoing it. Meta arrives BEFORE the replay for exactly this reason.
        //
        // ONLY FOR A REAL TERMINAL. A piped process reports 0x0 and has no screen to emulate; its
        // output is lines, which the buffer already models correctly.
        if (result.meta.cols > 0 && result.meta.rows > 0) this.#openScreen(result.meta);
      }
      if (frame.type === FRAME_OUTPUT) {
        // BOTH SINKS, ALWAYS. The buffer keeps the line model that non-painting processes need and
        // that decides whether this is a picture at all; the screen keeps the picture. Feeding only
        // one would make the pane's own `isPainting()` disagree with what it has to draw.
        this.#paint(frame.text);
      }
      if (result.done) {
        this.status = EXITED;
        this.exit = result.exit;
        return true;
      }
    }
    return false;
  }

  #fail(error) {
    // A stop() we asked for is not a failure, and reporting it as one would make every closed pane
    // look like a broken connection.
    if (error && error.name === "AbortError") return this;
    this.status = FAILED;
    this.reason = (error && (error.cause?.code ?? error.message)) || "the connection failed";
    return this;
  }

  /** Stop reading. Safe to call twice, and safe to call before `start`. */
  stop() {
    // SET FIRST, so a screen still loading is disposed on arrival rather than stored. An operator can
    // hide a pane inside the same second they opened it, and `#openScreen` resolves afterwards either
    // way -- the flag is how that late resolution learns it has no pane to belong to.
    this.stopped = true;
    try {
      this.controller?.abort();
    } catch {
      // Already gone; nothing to do and nothing worth reporting.
    }
    // DISPOSED WITH THE STREAM, and this is the leak that matters: a screen is a parser holding a
    // grid, and one per hidden pane on a host running twenty agents is twenty grids nobody reads.
    // Disposal also advances the emulator's generation, so a write callback that fires afterwards --
    // measured on the real package -- cannot report progress for a screen already handed on.
    try {
      this.screen?.dispose();
    } catch {
      // A screen that throws on disposal has already stopped mattering.
    }
    this.screen = null;
    this.pendingPaint = [];
    return this;
  }

  /** What a pane should show right now: the output, or the reason there is none. */
  lines({ height = 10, width = 80, color = false } = {}) {
    // THE ID GOES WITH IT so the painting notice can name the exact attach command rather than a
    // placeholder. The follower is the only party that knows which process this pane is showing.
    // THE SCREEN, WITH ITS OWN VERDICT ON WHETHER IT CAN BE BELIEVED. The pane decides what to do
    // with those two facts; this decides only what they ARE. `null` when no emulator was built, which
    // is the machine with no optional dependency and the piped process with no terminal -- and the
    // pane then says exactly what it has always said.
    // THE VERDICT TRAVELS EVEN WITHOUT AN EMULATOR, and that is the correction. It used to be built
    // only when a screen existed, so a stream with no emulator -- or whose retained suffix happens to
    // contain no cursor commands -- fell through to the pane's LINE path, which prints the buffer raw.
    // Review reproduced the disclosure: `ESC[8m` lost off the front, `SYNTHETIC_HIDDEN` in the
    // suffix, `isPainting()` false, and the pane printed the secret.
    //
    // ABSENCE OF CURSOR COMMANDS IN A TRUNCATED SUFFIX IS NOT EVIDENCE OF LOG SEMANTICS. The SGR
    // state that governs those bytes fell off the front with everything else.
    //
    // ONLY WHERE WE AFFIRMATIVELY KNOW, which is the one asymmetry against the screen rule and it is
    // deliberate: with no `meta` at all -- a daemon older than this feature -- refusing would leave
    // its operators with no pane at all rather than a possibly-wrong one, and that daemon predates
    // the whole mechanism. Known-truncated refuses; unknown keeps what it always did.
    const unsound = this.meta && !baselineIsSound(this.meta, this.repaintedSince)
      ? baselineProblem(this.meta, this.repaintedSince)
      : "";
    const screen = this.screen || unsound
      ? { rows: this.screen ? this.screen.rows({ color }) : [], problem: unsound }
      : null;
    const rows = this.buffer.view({ height, width, agent: this.id, screen });
    // A NON-EMPTY BUFFER WINS. A process that printed and then died should still show what it said --
    // its last words are usually the reason it died.
    if (rows.length) return rows;
    return [this.emptyReason()];
  }

  /** Why a pane is empty, in the words an operator needs. Never "" -- see the status list above. */
  emptyReason() {
    if (this.status === GONE) return this.reason ?? "no such process";
    if (this.status === FAILED) return `unavailable: ${this.reason ?? "the connection failed"}`;
    if (this.status === EXITED) return "the process exited without printing anything";
    if (this.status === CONNECTING) return "connecting...";
    return "connected; nothing printed yet";
  }
}
