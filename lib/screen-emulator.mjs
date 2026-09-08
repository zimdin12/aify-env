// A real VT screen for one process, or nothing at all.
//
// WHY AN EMULATOR AND NOT A LINE BUFFER. `pane-buffer.mjs` keeps the last N lines a process PRINTED,
// which is right for something that prints and useless for something that PAINTS. A coding agent
// paints: `ESC[row;colH` to position, `ESC[K` to erase, `ESC[A`-`G` to step. Replaying that as lines
// gives text in the wrong order, so the pane refuses to draw it at all. The browser has no such
// problem because it runs a VT emulator -- `index.html` loads `@xterm/xterm@5.5.0`. This is that same
// emulator without the DOM.
//
// OPTIONAL, EXACTLY LIKE `node-pty`. This package has no hard dependencies and the view degrades
// honestly when a native module is missing; the console degrades the same way. `create()` returns
// null when the package is absent and every caller falls back to the notice that names
// `aify-env attach`. The suite runs both arms -- installed and physically absent -- because an
// uninstalled green suite certifies nothing about cell extraction or Unicode activation.
//
// ── FOUR THINGS MEASURED ON THE REAL PACKAGE, each of which would be a defect if assumed
//
// GEOMETRY IS THE PRODUCER'S, NEVER THE PANE'S. Identical bytes at 80 and 40 columns do not clip
// differently, they WRAP: a row-1 overflow lands on row 2 and collides with what belongs there. A
// pane-sized emulator does not show less of the screen, it shows a different and wrong one. So the
// caller passes the PTY's geometry and the pane crops afterwards.
//
// UNICODE 11 IS NOT THE DEFAULT. A bare headless terminal reports `activeVersion === "6"`, where the
// browser loads `@xterm/addon-unicode11`. Measured: an emoji is one cell at 6 and two cells at 11, so
// every character after one sits in a different column. "Same parser" is only parity when it is the
// same parser CONFIGURED THE SAME WAY, which is asserted in a test rather than assumed here.
//
// ROWS ARE BUILT FROM CELLS, NOT FROM `translateToString`. That helper returns SGR-8 CONCEALED text
// verbatim -- `ESC[8mSECRETVALUE` comes back as plain `SECRETVALUE`. An agent conceals for a reason,
// and a pane that prints it is disclosing what the terminal was told to hide. Concealed cells become
// spaces rather than being dropped, because dropping would shift everything after them.
//
// A WRITE CALLBACK FIRES AFTER `dispose()`. Measured true, and it is the superseded-mount defect with
// a new door: a late callback writing into the pane after the operator switched agents. Every
// callback checks a generation that disposal advances.

//: The packages this needs, and the fact that BOTH are optional. Named here rather than typed at each
//: import so a reader learns the dependency in one place.
const EMULATOR_PACKAGE = "@xterm/headless";
const UNICODE_PACKAGE = "@xterm/addon-unicode11";

/**
 * The `Terminal` class and the Unicode 11 addon, or null when the emulator is not installed.
 *
 * COMMONJS, so the default export is destructured. A named `import { Terminal }` throws at load
 * against the real package -- it is a CJS module and Node cannot statically name its exports -- which
 * is a failure that would only appear on a machine where the package IS present.
 *
 * THE ADDON IS SEPARATELY OPTIONAL. Its absence costs column parity with the browser, which is a
 * degradation worth taking over refusing to draw anything; its presence is what makes the two
 * surfaces agree. The caller is told which it got.
 */
export async function loadEmulator() {
  let Terminal;
  try {
    const headless = await import(EMULATOR_PACKAGE);
    Terminal = headless?.default?.Terminal ?? headless?.Terminal;
  } catch {
    return null;
  }
  if (typeof Terminal !== "function") return null;

  let Unicode11Addon = null;
  try {
    const addon = await import(UNICODE_PACKAGE);
    Unicode11Addon = addon?.default?.Unicode11Addon ?? addon?.Unicode11Addon ?? null;
  } catch {
    // Column parity is lost and the screen is still worth drawing.
  }
  return { Terminal, Unicode11Addon };
}

/** Whether this cell's content was hidden by the process that wrote it. */
function isConcealed(cell) {
  return typeof cell?.isInvisible === "function" ? Boolean(cell.isInvisible()) : false;
}

/**
 * One process's screen.
 *
 * A CLASS because it has identity and state -- one screen per process, carrying what that process
 * painted. Reading it is a pure walk over cells, which is why `screen-render.mjs` exists separately
 * and can be tested with literals.
 */
export class ScreenEmulator {
  /**
   * Build one at the PRODUCER's geometry, or return null when the emulator is not installed.
   *
   * @param {{cols: number, rows: number}} geometry the PTY's own size, never the pane's
   */
  static async create({ cols = 80, rows = 24 } = {}) {
    const loaded = await loadEmulator();
    if (!loaded) return null;
    return new ScreenEmulator(loaded, { cols, rows });
  }

  constructor({ Terminal, Unicode11Addon }, { cols, rows }) {
    // `allowProposedApi` is REQUIRED for buffer access. Without it the cell API this whole file is
    // built on throws, and the failure arrives at the first read rather than at construction.
    this.term = new Terminal({
      cols: Math.max(1, Math.floor(cols) || 1),
      rows: Math.max(1, Math.floor(rows) || 1),
      allowProposedApi: true,
      // The screen is never scrolled back through here -- the pane shows the CURRENT picture -- so
      // scrollback is memory spent on something nothing reads.
      scrollback: 0,
    });
    if (Unicode11Addon) {
      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = "11";
    }
    //: Advanced by `dispose()`. Every write callback compares against it, because a queued callback
    //: outlives disposal and would otherwise report progress for a screen nobody owns any more.
    this.generation = 0;
    this.disposed = false;
  }

  /** Which Unicode version this screen measures with. `"11"` means parity with the browser. */
  get unicodeVersion() {
    return String(this.term?.unicode?.activeVersion ?? "");
  }

  /**
   * Feed bytes, resolving when the parser has actually applied them.
   *
   * NOT FIRE AND FORGET. `write` is asynchronous and uses zero-delay timers, so reading the buffer on
   * the next line returns the PREVIOUS screen. Every caller has to await this or it will render one
   * chunk behind, which looks like lag and is actually a missing await.
   */
  write(chunk) {
    const text = String(chunk ?? "");
    if (this.disposed || !text) return Promise.resolve(false);
    const generation = this.generation;
    return new Promise((resolve) => {
      this.term.write(text, () => {
        // THE GENERATION CHECK IS THE POINT. This callback fires after `dispose()` on the real
        // package -- measured -- so without it a late resolution reports a screen that has been
        // handed to a different process.
        resolve(!this.disposed && generation === this.generation);
      });
    });
  }

  /**
   * The screen as rows of text, top first.
   *
   * FROM CELLS, so concealed content never leaves this method. A width-0 cell is the continuation of
   * a wide character and contributes nothing, which is exactly what its empty `getChars()` gives --
   * so the walk needs no special case, and a test pins that rather than trusting it.
   */
  rows() {
    if (this.disposed) return [];
    const buffer = this.term.buffer.active;
    const out = [];
    for (let y = 0; y < this.term.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) { out.push(""); continue; }
      let text = "";
      for (let x = 0; x < this.term.cols; x += 1) {
        const cell = line.getCell(x);
        if (!cell) continue;
        // WIDTH 0 IS A CONTINUATION CELL -- the second half of a wide character, whose glyph was
        // already emitted by the cell before it. It contributes nothing, and adding a space for it
        // would push the rest of the row one column right for every emoji on screen.
        if (cell.getWidth() === 0) continue;
        // AN EMPTY CELL IS A SPACE. This is the one that bit: `getChars()` returns "" for a blank
        // cell, so concatenating it verbatim COLLAPSED every gap -- `ESC[2;3HHELLO` came back as
        // "HELLO" instead of "  HELLO", which destroys the positioning that is the entire reason for
        // running an emulator rather than a line buffer. Caught by the first smoke test.
        if (isConcealed(cell)) {
          // A SPACE, NOT A DELETION, for the same reason: removing concealed content would pull the
          // rest of the row left and misplace everything the agent positioned after it.
          text += " ";
          continue;
        }
        text += cell.getChars() || " ";
      }
      out.push(text);
    }
    return out;
  }

  /**
   * Follow the producer to a new size.
   *
   * A RESIZE IS ORDERED AGAINST OUTPUT, and this method does not own that ordering -- the caller
   * feeding this screen does. Resizing between two chunks of a repaint reflows a half-drawn picture,
   * which is a different wrong screen rather than a smaller one.
   */
  resize({ cols, rows }) {
    if (this.disposed) return this;
    const c = Math.max(1, Math.floor(cols) || this.term.cols);
    const r = Math.max(1, Math.floor(rows) || this.term.rows);
    if (c !== this.term.cols || r !== this.term.rows) this.term.resize(c, r);
    return this;
  }

  /** Let go. Safe twice, and every write in flight stops counting. */
  dispose() {
    if (this.disposed) return this;
    this.disposed = true;
    this.generation += 1;
    try {
      this.term.dispose();
    } catch {
      // A terminal that throws on disposal has already stopped mattering.
    }
    return this;
  }
}
