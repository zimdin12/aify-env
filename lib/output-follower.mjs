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
      if (result.meta) this.meta = result.meta;
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
    try {
      this.controller?.abort();
    } catch {
      // Already gone; nothing to do and nothing worth reporting.
    }
    return this;
  }

  /** What a pane should show right now: the output, or the reason there is none. */
  lines({ height = 10, width = 80 } = {}) {
    // THE ID GOES WITH IT so the painting notice can name the exact attach command rather than a
    // placeholder. The follower is the only party that knows which process this pane is showing.
    const rows = this.buffer.view({ height, width, agent: this.id });
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
