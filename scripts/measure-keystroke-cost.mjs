// What a single keystroke costs the dashboard, counted in requests rather than guessed.
//
// THE SHAPE. Every branch of the key handler ends in `draw()`, and `draw()` begins with
// `await collectSnapshot(...)`. So moving the cursor one row re-asks the daemon for everything
// before the screen moves. The frame's own comment already records that collection is slow enough
// for a stop() race to be "the normal case" once health checks were added.
//
// WHAT THIS MEASURES: how many requests one frame issues, and to where. Each is a round trip the
// operator waits through before a keypress is visible. It does NOT measure their latency -- that
// belongs to a live daemon, and starting one is the operator's action.
//
// Run: node scripts/measure-keystroke-cost.mjs

import { fileURLToPath } from "node:url";

import { collectSnapshot } from "../lib/dashboard.mjs";

// `fileURLToPath`, not `.pathname`: on Windows the latter yields a leading-slash "/C:/..."
// that `readFile` cannot open, and the registry read fails into an empty service list --
// which silently removed a probe from the count this script exists to make.
const REGISTRY_PATH = fileURLToPath(new URL("./measure-draw-cost.registry.json", import.meta.url));
const ENDPOINT = "http://127.0.0.1:8802";

const HEALTH = {
  version: "0.6.3",
  terminals: true,
  processes: Array.from({ length: 40 }, (_, i) => ({
    id: `proc-${i}`, label: `agent-${i}`, title: `claude — task ${i}`,
    status: "running", pid: 10000 + i,
  })),
  unknown: [],
  traffic: { requests: 1200, bytesOut: 8_400_000 },
};

const asked = [];

async function countingFetch(url) {
  asked.push(String(url));
  const body = JSON.stringify(HEALTH);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(body),
    text: async () => body,
    body: null,
  };
}

// THE OPTIONS THE REAL ENTRY POINTS PASS. A first version of this probe omitted them and counted
// one request; bin/aify-env-tui.mjs supplies both timeouts, so leaving them out measured a path
// nothing takes.
await collectSnapshot({
  endpoint: ENDPOINT,
  registryPath: REGISTRY_PATH,
  fetchImpl: countingFetch,
  probeTimeoutMs: 1500,
  agentsTimeoutMs: 6000,
});

console.log(`ONE snapshot issued ${asked.length} request(s):\n`);
const byUrl = new Map();
for (const url of asked) byUrl.set(url, (byUrl.get(url) || 0) + 1);
for (const [url, n] of byUrl) console.log(`  ${String(n).padStart(2)}x  ${url}`);

console.log(
  `\nEvery keystroke runs one of these before the screen moves: the key handler ends in draw(),`
  + `\nand draw() begins by awaiting collectSnapshot. ${asked.length} round trip(s) per keypress.`,
);
