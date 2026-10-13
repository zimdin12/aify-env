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

test("THE DAEMON PASSES ITS CWD_ROOTS to both", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs"), "utf8");
  for (const call of ["pluginHeartbeatBody(", "environmentAdvertisement("]) {
    const at = source.indexOf(call, source.indexOf("const CWD_ROOTS"));
    assert.ok(at > 0, `${call} not found after CWD_ROOTS`);
    const args = source.slice(at, source.indexOf(");", at));
    assert.match(args, /launchRoots: CWD_ROOTS/, `${call} does not pass the bound`);
  }
});
