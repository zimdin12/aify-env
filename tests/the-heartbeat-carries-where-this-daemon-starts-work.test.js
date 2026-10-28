// Both heartbeats carry this daemon's own launch bound as `metadata.launchRoots` (lib/advertise.mjs).
//
// 0.9.2 review: aify-comms reads it to say a managed agent this daemon will never start is not `available`, and the
// bound was reported only on /health, so the service judged against roots some other caller had left behind. The
// daemon (bin/aify-env.mjs) is never imported by a test; its two call sites are read instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { environmentAdvertisement, pluginHeartbeatBody } from "../lib/advertise.mjs";

const ROOTS = ["C:\\"];

test("BOTH BODIES CARRY THE BOUND as metadata.launchRoots, and never as cwdRoots, the service's policy", () => {
  for (const body of [pluginHeartbeatBody({ launchRoots: ROOTS }), environmentAdvertisement({ launchRoots: ROOTS })]) {
    assert.deepEqual(body.metadata.launchRoots, ROOTS);
    assert.equal("cwdRoots" in body, false);
  }
  assert.equal("launchRoots" in pluginHeartbeatBody({}).metadata, false, "CONTROL: no bound given, none claimed");
});

test("THE DAEMON PASSES ITS CWD_ROOTS to both", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs"), "utf8");
  // The plugin heartbeat's body is built in the daemon; the advertisement's by its advertiser, from the host facts the
  // daemon hands it (lib/host-advertiser.mjs), so each is read where its bound is given.
  const after = (call, end) => { const at = source.indexOf(call, source.indexOf("const CWD_ROOTS")); return at > 0 ? source.slice(at, source.indexOf(end, at)) : ""; };
  assert.match(after("pluginHeartbeatBody(", ");"), /launchRoots: CWD_ROOTS/, "the plugin heartbeat does not pass the bound");
  assert.match(after("new HostAdvertiser({", "\n});"), /launchRoots: CWD_ROOTS/, "the advertiser's host facts do not carry the bound");
  // AND THE ADVERTISER SENDS WHAT IT IS GIVEN: its body carries the host's launchRoots.
  const { HostAdvertiser } = await import("../lib/host-advertiser.mjs");
  const bodies = [];
  await new HostAdvertiser({ enabled: true, everyMs: 30_000, redetectMs: 300_000, harnesses: () => [], pathFor: () => "/api/v1/environments",
    readRegistry: () => JSON.stringify({ version: 1, services: { svc: { endpoint: "http://127.0.0.2:1/mcp/sse" } } }),
    host: () => ({ hostname: "h", kind: "windows", os: "windows", machineId: "win32:h", launchRoots: ROOTS }),
    credentialReading: () => ({}), credential: async () => "", env: {},
    post: async (_url, body) => { bodies.push(body); return { ok: true, status: 204 }; } }).beat();
  assert.equal(bodies.length, 1, "CONTROL: the beat posted");
  assert.deepEqual(bodies[0].metadata.launchRoots, ROOTS, "the advertisement dropped the bound it was given");
});
