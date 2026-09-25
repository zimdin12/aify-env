// A burst of notices fits the terminal on an idle host, as it already did on a busy one.
//
// THE DEFECT (v0.7 scan, F12). The height fitting returned early for 0 or 1 processes BEFORE the loop
// that trims notices, so on an idle host -- the common case -- twenty notices made the frame longer
// than the terminal. The compositor then cut the bottom: NOTICES said "N recent" over fewer rows, and
// TRAFFIC vanished.

import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboard } from "../lib/tui.mjs";

const notices = Array.from({ length: 20 }, (_, i) => ({ text: `notice ${i}`, count: 1, atMs: 0 }));
const snapshot = (count) => ({
  version: "0.7.0", endpoint: "http://127.0.0.1:8802", terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 3 }, nowMs: 0, notices,
  processes: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, label: `agent-${i}` })),
});

for (const count of [0, 1, 2]) {
  test(`${count} process(es) and twenty notices fit a 24-row terminal, TRAFFIC included`, () => {
    const lines = renderDashboard(snapshot(count), { columns: 100, rows: 24 });
    assert.ok(lines.length <= 24, `${lines.length} lines for 24 rows`);
    assert.ok(lines.some((line) => line.startsWith("TRAFFIC")), "the TRAFFIC section was pushed off");
  });
}
