// Which viewer of a terminal decides its size.
//
// ONE PTY, SEVERAL VIEWERS. A worker is shown in a Herdr pane (`aify-env attach`) and in the dashboard's
// web console at the same time, and each tells this host its own size. Until 2026-09-28 the last resize
// simply won, and every other viewer then showed redraws for a size it is not: the operator's Herdr pane
// held frames of two widths fused together, and its scrollback kept them. Measured that evening from the
// service's `terminal_controls`: both scrambled workers were last resized by the dashboard console
// (157x32 at 16:42, 157x29 at 14:29, each the second half of a Refresh nudge) while their Herdr panes
// were 40 rows.
//
// THE RULE IS TMUX'S `window-size latest`: the viewer that last typed or resized owns the size. A resize
// is a viewer saying "this is me now"; a keystroke from a viewer that is not the owner hands the
// terminal back to it BEFORE the keystroke lands, so the agent redraws for the screen the operator is
// actually typing into. Chosen over tmux's `smallest` because this host cannot see a viewer leave: a
// browser tab closes without a word, and a smallest-wins rule would keep a closed tab's size for ever.
//
// A VIEWER WITHOUT A NAME (an older client, a caller that never said) still resizes, as before, and
// takes ownership away from every named viewer, so the next named one to type takes it back. Its
// keystrokes never resize anything: there is no size on record to restore.

/** Viewers remembered per terminal. Each attach mints a fresh name, so this bounds a long-lived worker. */
export const MAX_VIEWERS = 8;

export class TerminalSizeOwner {
  /** viewer -> {cols, rows}, least recently active first. */
  #sizes = new Map();

  /** The viewer whose size the terminal has now; "" when an unnamed caller set it. */
  #owner = "";

  /**
   * A resize the terminal has TAKEN. Called after the PTY accepted it, never before: a refused resize
   * must not make its viewer the owner of a size nothing has.
   */
  resized(viewer, cols, rows) {
    this.#owner = viewer || "";
    if (!viewer) return;
    this.#sizes.delete(viewer);
    this.#sizes.set(viewer, { cols, rows });
    while (this.#sizes.size > MAX_VIEWERS) this.#sizes.delete(this.#sizes.keys().next().value);
  }

  /**
   * A viewer is about to type. Returns the size the terminal must take first, or null when it already
   * has this viewer's size or the viewer never declared one.
   */
  sizeBeforeInput(viewer) {
    if (!viewer || viewer === this.#owner) return null;
    const size = this.#sizes.get(viewer);
    return size ? { ...size } : null;
  }

  /** Who owns the size now ("" for an unnamed caller). For tests and diagnostics. */
  get owner() { return this.#owner; }
}

/** A viewer name as a request carries it: absent is fine, anything but a short string is refused. */
export function viewerFrom(body) {
  const viewer = body?.viewer;
  if (viewer === undefined || viewer === null || viewer === "") return { ok: true, value: "" };
  if (typeof viewer !== "string" || viewer.length > 64) {
    return { ok: false, error: "`viewer` must be a string of at most 64 characters" };
  }
  return { ok: true, value: viewer };
}
