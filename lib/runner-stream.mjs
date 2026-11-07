import { TerminalSizeOwner } from './terminal-size-owner.mjs';

// One child's replay and terminal geometry. Owned and mutated only by Runner.
export class RunnerStream {
  buffer = '';
  // A suffix is not a complete screen; neither are bytes straddling a resize.
  truncated = false;
  producedTotal = 0;
  resizedAtTotal = -1;
  listeners = new Set();
  resizeListeners = new Set();
  resizes = 0;
  sizeOwner = new TerminalSizeOwner();
  checkpoint = null;
  exitListeners = new Set();
  // Signalled children have a null exitCode too: observed death is a separate fact.
  exited = false;
  exitCode = null;
  exitSignal = '';

  constructor({ child, makeCheckpoint }) {
    if (makeCheckpoint && Number(child.cols) > 0 && Number(child.rows) > 0) {
      try { this.checkpoint = makeCheckpoint({ cols: Number(child.cols), rows: Number(child.rows) }); }
      catch { /* An unavailable checkpoint leaves ordinary stream replay intact. */ }
    }
  }
}
