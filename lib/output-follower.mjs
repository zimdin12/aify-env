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
    //: SET BY THE OWNER, called when this stream has advanced the pane. A plain field rather than a
    //: constructor option because the owner binds it to THIS instance after construction, so a late
    //: callback from a superseded follower can be told apart from the current one's.
    this.onProgress = null;
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
    this.pending = [];
    //: Every screen operation runs on this, so arrival order IS application order.
    this.applying = Promise.resolve();
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
    //: WHAT ARRIVED WHILE THE EMULATOR LOADED, in order, including RESIZES. Holding only text and
    //: applying the current geometry on arrival replays old bytes at a width they never had.
    this.pending = this.pending || [];
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
        // BORN AT THE GEOMETRY THE BACKLOG BEGINS IN, not at the latest one. Applying the newest size
        // first and THEN replaying older output paints those bytes at a width they were never
        // produced under -- review's third witness. The queue below carries the resizes that happened
        // meanwhile, so the screen walks the same history the producer did.
        this.screen = screen;
        const pending = this.pending;
        this.pending = [];
        for (const event of pending) {
          if (event.kind === "resize") this.#applyResize(event.cols, event.rows);
          else this.#applyWrite(event.text, event.repaints);
        }
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
      if (this.screenOpening) this.pending.push({ kind: "text", text, repaints });
      return;
    }
    this.#applyWrite(text, repaints);
  }

  /**
   * Feed the screen, IN ORDER WITH EVERY OTHER OPERATION.
   *
   * `write` is asynchronous and `resize` is not, so a resize issued while a write was still in the
   * parser's queue applied AHEAD of it -- and review measured the consequence exactly: at 80 columns
   * write `ESC[1;61HOLD`, resize to 40, write again, and an `O` survives at column 40 where a
   * correctly ordered terminal leaves the row blank. Reflowing a screen the parser has not finished
   * painting is not a smaller error than reflowing the wrong screen; it IS the wrong screen.
   *
   * ONE CHAIN, so arrival order is application order. Every link swallows its own failure: a rejected
   * write must not break the chain for everything behind it, because the next frame would then be
   * applied to a screen missing the one before it.
   */
  #applyWrite(text, repaints) {
    this.applying = this.applying
      .then(() => this.screen?.write(text))
      // THE FLAG FOLLOWS THE PARSER, not the arrival. Setting it here would declare the screen sound
      // while the buffer still holds the pre-reset picture.
      .then((applied) => { if (applied && repaints) this.repaintedSince = true; })
      .catch(() => {});
  }

  /** Resize the screen, on the same chain, so it cannot overtake output already queued. */
  #applyResize(cols, rows) {
    this.applying = this.applying
      .then(() => { this.screen?.resize({ cols, rows }); })
      .catch(() => {});
  }

  /**
   * Why this pane is showing a notice instead of the process, or "" when it is showing the process.
   *
   * A RENDERED REFUSAL IS NOT A TERMINAL. The pane can be drawn, current and streaming while what it
   * DISPLAYS is "waiting for the first full repaint" -- and input was still forwarded into it, so the
   * operator typed at an agent whose screen they had explicitly been told they were not seeing.
   * Review measured it on a truncated stream with a matching complete-stream control.
   *
   * The same question `lines()` already answers for itself, exposed so the session can gate input on
   * it rather than deriving it a second way.
   */
  paneProblem() {
    if (!this.buffer.length) return "";
    return baselineIsSound(this.meta, this.repaintedSince)
      ? ""
      : baselineProblem(this.meta, this.repaintedSince);
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
        const moved = this.meta
          && (this.meta.cols !== result.meta.cols || this.meta.rows !== result.meta.rows);
        if (moved && this.screen) this.#applyResize(result.meta.cols, result.meta.rows);
        // HELD AS AN EVENT when the emulator has not loaded yet, so the backlog carries the geometry
        // HISTORY rather than only its endpoint. Without this the replay paints old bytes at the
        // newest width, which is the same wrong screen from the other direction.
        else if (moved && this.screenOpening) this.pending.push({
          kind: "resize", cols: result.meta.cols, rows: result.meta.rows,
        });
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
        this.#reportProgress();
        return true;
      }
    }
    // ONCE PER CHUNK, NOT ONCE PER FRAME. A chunk can carry many frames and the owner only needs to
    // know that the pane moved. Reporting per frame would multiply the caller's coalescing work for
    // no extra information.
    if (frames.length) this.#reportProgress();
    return false;
  }

  /**
   * Tell the owner the pane has advanced.
   *
   * NEVER THROWS INTO THE READ LOOP. This runs inside `for await (const chunk of response.body)`,
   * and an owner's callback that threw would abort the stream -- turning a redraw problem into a
   * dead console.
   */
  #reportProgress() {
    try {
      this.onProgress?.();
    } catch {
      // A view that cannot draw is not a reason to stop reading the process.
    }
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
    this.pending = [];
    //: Every screen operation runs on this, so arrival order IS application order.
    this.applying = Promise.resolve();
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
    // UNKNOWN REFUSES TOO, and this reverses a call I made and asked review to check. I had let a
    // stream with NO `meta` keep the raw path, reasoning that a daemon older than this feature should
    // degrade rather than go blank. Review answered with the witness that settles it: the
    // complete-history oracle CONCEALS the synthetic token and the no-meta follower PRINTS it.
    // Compatibility is not a reason to disclose.
    //
    // AND IT WAS WORSE THAN THE CASE I ARGUED FOR. A `meta` frame carrying `null` or an array is
    // REJECTED as unreadable by the parser, which leaves `this.meta` null -- so malformed metadata
    // took the same permissive path as an absent one. Two of the three disclosing arms were not old
    // daemons at all; they were broken frames.
    //
    // THE COST IS STATED RATHER THAN HIDDEN: a pre-0.6.3 daemon now shows the notice instead of its
    // output. That is a real regression for that configuration and it is the operator's to reverse --
    // an explicitly authorised legacy policy, excluded from any disclosure-safe claim -- not mine to
    // assume while they are asleep.
    // AN EMPTY BUFFER HAS NOTHING TO DISCLOSE, so it is not refused -- it is EXPLAINED. A 404, a 500
    // and a process that exited without printing each have a reason the operator can act on, and
    // replacing those with "waiting for a repaint" would hide a better answer behind a guard that is
    // guarding nothing. Caught by an existing test the moment unknown metadata started refusing.
    const unsound = this.paneProblem();
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
