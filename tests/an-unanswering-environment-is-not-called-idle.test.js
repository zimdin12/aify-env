// With the daemon not answering, PROCESSES says so instead of stating a fact about it.
//
// THE DEFECT (v0.7 scan, F16). When `/health` failed, `history` defaulted to `{startedTotal: 0}` and
// the idle branch then said "nothing started since this environment came up — no spawn has reached
// it yet": a claim about an environment that did not answer. The header said "not answering" and the
// section under it contradicted it.

import assert from "node:assert/strict";
import test from "node:test";

import { collectSnapshot } from "../lib/dashboard.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const collect = (fetchImpl) => collectSnapshot({
  endpoint: "http://127.0.0.2:1",
  registryPath: "/nonexistent/services.json",
  readFile: () => { throw new Error("no registry"); },
  readCredentialStore: () => ({ entries: [] }),
  fetchImpl,
});

test("an environment that did not answer is UNKNOWN, not idle", async () => {
  const snapshot = await collect(async () => { throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }); });
  assert.equal(snapshot.answered, false);
  const text = renderDashboard(snapshot, { columns: 120 }).join("\n");
  assert.doesNotMatch(text, /nothing started since this environment came up/);
  assert.match(text, /unknown — the environment is not answering/);
});

test("CONTROL: an environment that answered with nothing running is still called idle", async () => {
  const snapshot = await collect(async () => ({
    ok: true, status: 200, json: async () => ({ version: "0.7.0", processes: [], history: { startedTotal: 0 } }),
  }));
  assert.equal(snapshot.answered, true);
  assert.match(renderDashboard(snapshot, { columns: 120 }).join("\n"), /nothing started since this environment came up/);
});
