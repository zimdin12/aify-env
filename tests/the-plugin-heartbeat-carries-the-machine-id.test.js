// The aify-comms plugin's claimer heartbeat carries this host's machine id.
//
// The service fences a definition push and a change-request claim on the environment row's machine id
// (aify-comms P0 C3/C4). The full advertiser normally supplies it; a registry entry with
// `"advertise": false` stops that advertiser, leaving the plugin's heartbeat the only writer, and without
// the id both calls were refused 409 (comms-senior-dev's whole-range review of 0.8, executed against the
// final service). The body is built by a pure function because the daemon (bin/aify-env.mjs) is never
// imported by a test; its one call site is read instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hostIdentityFacts, pluginHeartbeatBody } from "../lib/advertise.mjs";
import { CommsApi, mintBridgeIdentity } from "../lib/plugins/aify-comms/api.mjs";

const HOST = { hostname: "StevenZ-L", kind: "windows", machineId: "win32:stevenz-l", instance: "b1", codeOnDisk: "b1" };

test("THE BODY carries the machine id, and the currency pair only when it is known", () => {
  assert.deepEqual(pluginHeartbeatBody(HOST),
    { hostname: "StevenZ-L", kind: "windows", machineId: "win32:stevenz-l", metadata: { instance: "b1", codeOnDisk: "b1" } });
  assert.equal("codeOnDisk" in pluginHeartbeatBody({ ...HOST, codeOnDisk: null }).metadata, false);
});

test("THE REQUEST the plugin sends keeps it: the body through CommsApi.heartbeat to the wire", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } };
  };
  const api = new CommsApi({ endpoint: "http://127.0.0.1:8800", credential: async () => "k",
    identity: mintBridgeIdentity({ version: "0.8.0" }), fetchImpl });
  await api.heartbeat(pluginHeartbeatBody(HOST), { heldTerminals: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/environments\/heartbeat$/);
  assert.equal(calls[0].body.machineId, "win32:stevenz-l");
  assert.ok(calls[0].body.bridgeId, "CONTROL: the plugin's own bridge id still travels");
});

test("THE DAEMON builds the plugin heartbeat from the host's machine id, through this function", () => {
  const daemon = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs"), "utf8");
  const body = /function currentAdvertisementBody\(\) \{([\s\S]*?)\n\}/.exec(daemon);
  assert.ok(body, "the extractor found the daemon's builder");
  assert.match(body[1], /const \{ kind, machineId \} = hostIdentityFacts\(/);
  assert.match(body[1], /return pluginHeartbeatBody\(\{[^}]*\bmachineId\b[^}]*\}\);/);
  // And the id is the one hostIdentityFacts answers, not a second derivation.
  assert.equal(hostIdentityFacts({ platform: "win32", hostname: "StevenZ-L" }).machineId.length > 0, true);
});
