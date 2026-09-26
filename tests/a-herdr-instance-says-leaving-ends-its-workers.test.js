// In a `herdr-aify env` instance, the daemon's own view says that leaving Herdr ends every worker.
//
// THE DEFECT (v0.7 scan, F21). In that instance a Herdr detach -- harmless muscle memory in the
// resident `herdr-aify` -- tears down the dedicated environment and all its workers. That lifetime is
// the operator's ruling; the problem is the warning. It was written to stderr immediately before the
// Herdr TUI took the screen, so it was covered at once (that it is covered is ASSUMED). The daemon's
// pane is the one place that stays visible for the life of the instance, so the warning lives there.

import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboard } from "../lib/tui.mjs";
import { startDaemonView } from "../lib/daemon-view.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const snapshot = {
  version: "0.7.0", endpoint: "http://127.0.0.1:8802", terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 2 },
  processes: [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }],
};

test("the header of an instance's view says what leaving Herdr does, and to how many workers", () => {
  const text = renderDashboard(snapshot, { columns: 120, endsWithHerdr: true }).join("\n");
  assert.match(text, /leaving this Herdr session ends this environment and its 2 workers/);
});

test("CONTROL: an ordinary daemon's view says nothing of the kind", () => {
  assert.doesNotMatch(renderDashboard(snapshot, { columns: 120 }).join("\n"), /leaving this Herdr/);
});

test("the daemon turns it on exactly where it opens a Herdr space per worker", async () => {
  const calls = [];
  const start = async (options) => { calls.push(options); return { stop: () => {} }; };
  const tty = { isTTY: true, columns: 120, rows: 40 };
  await startDaemonView({ endpoint: "e", registryPath: "r", stdout: tty, stdin: tty, herdrSpaces: true, start });
  await startDaemonView({ endpoint: "e", registryPath: "r", stdout: tty, stdin: tty, herdrSpaces: false, start });
  assert.equal(calls[0].endsWithHerdr, true);
  assert.equal(Boolean(calls[1].endsWithHerdr), false);
});

// THE LINK BETWEEN THE TWO TESTS ABOVE (v0.7.1 review, E5). The renderer is tested with the flag and
// the daemon is tested passing it, and deleting the line in `startDashboard` that hands it to the
// renderer left all three green. This drives the view itself.
test("the view hands the flag to the renderer it draws with", async () => {
  const frame = async (endsWithHerdr) => {
    let written = "";
    await startDashboard({
      endpoint: "http://127.0.0.2:1",
      registryPath: "/nonexistent/services.json",
      once: true,
      clearScreen: false,
      columns: 120,
      rows: 40,
      endsWithHerdr,
      write: (text) => { written += text; },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
      readFile: () => { throw new Error("no registry"); },
    });
    return written;
  };
  assert.match(await frame(true), /leaving this Herdr session ends this environment and its 2 workers/);
  assert.doesNotMatch(await frame(false), /leaving this Herdr/, "CONTROL: the line was drawn without the flag");
});
