// An empty PROCESSES panel says whether the environment is idle or has never been asked.
//
// REPORTED BY THE OPERATOR, 2026-08-25. Their aify-env showed "no processes owned by this environment"
// while the aify-comms dashboard listed nineteen managed agents, and they read it as a bug. It was not:
// managed workers start on demand, and at that instant this environment genuinely owned nothing.
// Measured minutes later, the same environment held four, one of them five minutes old.
//
// The panel was accurate and unreadable. It gave no way to separate the two empties that matter:
//
//   * IDLE      — it has started work before and nothing is running this second.
//   * UNREACHED — nothing has EVER been asked of it, which is what a broken delegation looks like.
//
// Answered from this environment's OWN counters. It must never fetch a service's agent list to explain
// itself; a first version of the dashboard did exactly that and the operator's ruling reverted it --
// "aify-env should not ask stuff from aify-comms, it is not aify-env's concern."
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProcessRegistry } from "../lib/process-registry.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const BASE = {
  version: "0.6.0",
  endpoint: "http://127.0.0.1:8802",
  terminals: { available: true, reason: "" },
  services: [],
  processes: [],
  unknown: [],
  traffic: { requests: 0, bytesOut: 0 },
};

function panel(snapshot) {
  const lines = renderDashboard({ ...BASE, ...snapshot }, { columns: 120, color: false });
  const at = lines.findIndex((l) => l.includes("PROCESSES"));
  assert.ok(at >= 0, "the PROCESSES heading vanished");
  return lines.slice(at, at + 4).join("\n");
}

// ── the registry's own bookkeeping ─────────────────────────────────────────────────────────────

test("the registry counts what it has started, not what it holds", () => {
  const registry = new ProcessRegistry();
  assert.equal(registry.history.startedTotal, 0);

  const a = registry.add({ service: "aify-comms", pid: 100 });
  const b = registry.add({ service: "aify-comms", pid: 200 });
  assert.equal(registry.history.startedTotal, 2);
  assert.equal(registry.size, 2);

  registry.remove(a.id, { atMs: 5_000 });
  registry.remove(b.id, { atMs: 9_000 });
  // The whole point: emptied, but it remembers having done the work.
  assert.equal(registry.size, 0);
  assert.equal(registry.history.startedTotal, 2, "the lifetime count went down with the live count");
  assert.equal(registry.history.lastExitAtMs, 9_000);
});

test("a reaper's second pass does not move a timestamp it did not cause", () => {
  // remove() is deliberately safe to run twice. If an unknown id still stamped the clock, every idle
  // reaper sweep would refresh "last exited" and the number would say a process died seconds ago
  // when the real one died an hour back.
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "aify-comms", pid: 100 });
  registry.remove(entry.id, { atMs: 1_000 });
  registry.remove(entry.id, { atMs: 99_000 });
  assert.equal(registry.history.lastExitAtMs, 1_000);
});

test("a caller that does not care about the time may still remove", () => {
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "aify-comms", pid: 100 });
  registry.remove(entry.id);
  assert.equal(registry.size, 0);
  assert.equal(registry.history.lastExitAtMs, null);
});

// ── what the operator actually reads ───────────────────────────────────────────────────────────

test("idle says so, and says how much this environment has run", () => {
  const text = panel({
    processes: [],
    history: { startedTotal: 12, lastExitAtMs: 1_000_000 },
    nowMs: 1_000_000 + 185_000,
  });
  assert.match(text, /idle/, "an idle environment is not labelled idle");
  assert.match(text, /12 started/, "the lifetime count is not shown, so idle is unprovable");
  assert.match(text, /last exited 3m ago/, "when the last one exited is not shown");
  assert.doesNotMatch(
    text, /no processes owned by this environment/,
    "still the ambiguous wording the operator misread",
  );
});

test("never asked reads differently from idle, because it is a different fact", () => {
  // This is what a delegation that never arrives looks like. Reporting it as "idle" would hide the
  // one empty state that IS worth investigating.
  const text = panel({ processes: [], history: { startedTotal: 0, lastExitAtMs: null }, nowMs: 5 });
  assert.match(text, /no spawn has reached it yet/);
  assert.doesNotMatch(text, /idle/, "an environment nothing has reached is reported as merely idle");
});

test("an idle environment that has never lost one yet omits the exit clause", () => {
  const text = panel({
    processes: [], history: { startedTotal: 3, lastExitAtMs: null }, nowMs: 1_000,
  });
  assert.match(text, /3 started/);
  assert.doesNotMatch(text, /last exited/, "a missing timestamp was rendered as a claim");
});

test("a missing clock produces no age rather than an invented one", () => {
  // nowMs absent is the shape an older caller sends. "just now" would be a fabricated observation.
  const text = panel({ processes: [], history: { startedTotal: 4, lastExitAtMs: 1_000 } });
  assert.match(text, /4 started/);
  assert.doesNotMatch(text, /ago/);
});

test("a snapshot with no history at all still renders", () => {
  // Every field here is optional on the wire: an environment running older code reports none of it,
  // and a view that throws on that turns a cosmetic gap into a blank screen.
  const text = panel({ processes: [] });
  assert.match(text, /no spawn has reached it yet/);
});

test("none of this appears when something IS running", () => {
  const text = panel({
    processes: [{ id: "p1", pid: 42, service: "aify-comms", terminal: true, uptimeMs: 60_000,
                  label: "sc-coder", title: "working" }],
    history: { startedTotal: 9, lastExitAtMs: 1_000 },
    nowMs: 2_000,
  });
  assert.match(text, /p1/);
  assert.doesNotMatch(text, /idle/, "a busy environment claimed to be idle");
  assert.doesNotMatch(text, /started since/);
});
