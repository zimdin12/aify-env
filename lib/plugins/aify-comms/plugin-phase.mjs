// The aify-comms plugin's CONFIGURATION PHASE (P0 C8): what a registry change has done to it, kept
// apart from the host going away, which is `stop()` and nothing here.
//
//   running    -> both loops run;
//   quiescing  -> no new pass begins, and a start control already in hand is refused;
//   held       -> the service was removed or moved but this host still runs its workers: the control
//                 loop serves them (starts refused), no spawn is claimed, the heartbeat goes on;
//   detached   -> nothing runs and nothing more is sent. No offline beat: the host is not going.

/** What a start is refused with while this plugin is being detached (P0 C8). */
export const DETACHING = "this service is being detached from this host";

/** The phase, the pass each loop has in flight, and the moves between them. */
export class PluginPhase {
  #phase = "running";
  //: The pass each loop has in flight, so a detach can wait for its long-poll to come back.
  #passes = new Map([["claim", Promise.resolve()], ["control", Promise.resolve()]]);

  /** The phase's name, for the plugin's reported state. */
  get name() { return this.#phase; }

  /** Whether a claim pass may begin or proceed past its setup. A held plugin claims nothing: a claimed
   *  spawn is a start it would then have to refuse. */
  get claims() { return this.#phase === "running"; }

  /** Whether a control pass may begin or proceed: while running, and while held for its workers. */
  get controls() { return this.#phase === "running" || this.#phase === "held"; }

  get detached() { return this.#phase === "detached"; }

  /** What a start is refused with now, or "" while running. */
  refusal() { return this.#phase === "running" ? "" : DETACHING; }

  /**
   * Record `pass` as the one `loop` has in flight, setup included, and hand it back to await.
   * @param {"claim"|"control"|"sync"|"lifecycle"} loop
   * @param {Promise<object>} pass
   */
  track(loop, pass) {
    this.#passes.set(loop, pass.catch(() => {}));
    return pass;
  }

  /** One loop's pass in flight, settled. Shutdown waits on the lifecycle pass, never on a claim long-poll. */
  settled(loop) { return this.#passes.get(loop) ?? Promise.resolve(); }

  /** Running again: a fresh start. */
  begin() { this.#phase = "running"; }

  /**
   * Stop new passes and wait for every pass in flight to come back.
   * @returns {Promise<boolean>} whether the plugin was already held, so a caller says "held" once
   */
  async quiesce() {
    const wasHeld = this.#phase === "held";
    this.#phase = "quiescing";
    await Promise.all(this.#passes.values());
    return wasHeld;
  }

  hold() { this.#phase = "held"; }

  detach() { this.#phase = "detached"; }

  /** The change that held it was undone. @returns {boolean} whether it was held, and so resumed */
  resume() {
    if (this.#phase !== "held") return false;
    this.#phase = "running";
    return true;
  }
}
