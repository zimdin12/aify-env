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
  // AND THE MODULE DOES NOT FINISH UNTIL THE VIEW DOES. External review, Round 8 H7.
  //
  // `startDashboard` resolves once the FIRST FRAME is painted -- it returns a handle, it does not
  // wait for the screen to be done with. So this module's top-level await completed immediately, and
  // both callers took that as the view having finished: the dispatcher does
  // `await import(target); process.exit(...)`, and the refused-takeover branch does the same and
  // even says "reached only if it returns". `aify-env tui` therefore painted one frame and exited 0
  // in well under a second, while running the file DIRECTLY kept going -- which is why it looked
  // fine to anyone testing it the obvious way.
  //
  // AND SOMETHING MUST HOLD THE EVENT LOOP, which a promise alone does not.
  //
  // `lib/dashboard.mjs` UNREFS its refresh timer, deliberately and correctly: inside the daemon the
  // view is a passenger and "a daemon exits when its own work says so". In THIS process the view is
  // the work, and that difference lives here, which is why the keepalive is here and not there.
  //
  // MEASURED, and it is why this is not just `await new Promise(() => {})`: with only the unref'd
  // timer, node found an empty loop with a pending top-level await and exited 13 -- a DIFFERENT
  // silent early exit from the one being fixed, reached in under a second. The first version of this
  // fix had exactly that bug.
  const keepAlive = setInterval(() => {}, 1 << 30);
  // The exits are `onQuit`, the two signal handlers above, and the daemon's death. There is no
  // fourth way for a view that owns nothing to be finished, so nothing resolves this.
  await new Promise(() => {});
  clearInterval(keepAlive);
} else {
  stop();
}
