#!/usr/bin/env node
// A live view of this environment, as its own command.
//
//   aify-env tui           refresh until interrupted
//   aify-env tui --once    render one frame and exit (what a script or a test wants)
//
// Bare `aify-env` renders the same view in the terminal that starts the daemon. Both call
// lib/dashboard.mjs, which owns the collecting and the drawing and deliberately owns no lifecycle --
// so the daemon's interrupt can stop its managed processes rather than being pre-empted by an exit
// handler belonging to a view.
//
// If the daemon is not answering it says so and keeps trying, rather than exiting: the common reason
// to have this open is watching for the moment something comes back.

import { homedir } from "node:os";
import { join } from "node:path";

import { startDashboard } from "../lib/dashboard.mjs";

const args = process.argv.slice(2);
const once = args.includes("--once");

const registryPath = process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json");
const endpoint = process.env.AIFY_ENV_ENDPOINT || "http://127.0.0.1:8802";

// THE CONSOLE NEEDS A KEYBOARD, so it is offered only when there is one. `--once` renders a frame for
// a script or a test and exits; a pipe has no selection to move and no terminal to put into raw mode,
// and opening a process stream there would be IO nobody asked for. The daemon's own startup banner
// calls the same function and deliberately passes no input for the same reason.
const interactive = !once && Boolean(process.stdin.isTTY);

const { stop } = await startDashboard({
  endpoint,
  registryPath,
  once,
  clearScreen: !once,
  input: interactive ? process.stdin : null,
  rows: process.stdout.rows || 24,
  // THIS process is only a view, so quitting is the whole of its shutdown -- but the decision stays
  // here rather than in lib, which owns no lifecycle on purpose.
  onQuit: () => {
    stop();
    process.exit(0);
  },
  // Writing to a process is the daemon's business. A view asks; it does not reach into a PTY.
  onInput: async (target, data) => {
    if (!target) return;
    try {
      await fetch(`${endpoint}/processes/${encodeURIComponent(target.id)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data }),
      });
    } catch {
      // A keystroke that did not land is not worth taking the screen down for; the pane's own status
      // is what reports a connection that has stopped working. The daemon answers 404 rather than
      // dropping a write to a process that has gone, which is what stops an operator typing into a
      // void and concluding the agent is ignoring them -- the pane shows that as `gone`.
    }
  },
  // A pipe gets no escapes: --once is what a script or a test uses, and colour in captured output is
  // noise that has to be stripped again by whoever reads it.
  columns: process.stdout.columns || 100,
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  intervalMs: Number(process.env.AIFY_TUI_REFRESH_MS || 2000),
  probeTimeoutMs: Number(process.env.AIFY_PROBE_TIMEOUT_MS || 1500),
  agentsTimeoutMs: Number(process.env.AIFY_AGENTS_TIMEOUT_MS || 6000),
});

if (!once) {
  // THIS process is only a view: it owns nothing, so exiting is the whole of its shutdown. The daemon
  // does not get to reuse this handler, which is why it lives here and not in lib.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
} else {
  stop();
}
