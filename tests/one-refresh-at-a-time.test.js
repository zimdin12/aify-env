// The refresh timer never starts a collection while the last one is still running (v0.7 scan, F26b).
//
// Service probes run one after another with their own timeouts, so a collection can outlast the
// interval; overlapping collections can then paint an older snapshot over a newer one.

import assert from "node:assert/strict";
import test from "node:test";

import { startDashboard } from "../lib/dashboard.mjs";

test("a refresh that is still collecting is not joined by another", async () => {
  let healthAsks = 0;
  let first = true;
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
    write: () => {}, clearScreen: false, intervalMs: 15,
    readFile: () => { throw new Error("no registry"); },
    readCredentialStore: () => ({ entries: [] }),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health")) {
        healthAsks += 1;
        // The first collection answers; every later one hangs, as a slow service does.
        if (!first) await new Promise(() => {});
        first = false;
      }
      return { ok: true, status: 200, json: async () => ({ processes: [] }) };
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  stop();
  assert.equal(healthAsks, 2, `${healthAsks} collections were started; one was still running the whole time`);
});
