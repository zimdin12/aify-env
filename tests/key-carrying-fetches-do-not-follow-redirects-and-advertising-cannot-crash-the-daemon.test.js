// Two host-tier defects found in review on 2026-09-08.
//
// 1. Both fetches that carry X-API-Key -- the plugin's #send and the daemon's advertisement -- used the
//    default redirect policy, so a 3xx from the endpoint would carry the key to wherever it pointed. The
//    bridge in aify-comms applies `redirect: "manual"` at every one of its fetch sites and gates it.
// 2. The advertisement pass ran as `void advertiseOnce()`. This daemon registers no unhandledRejection
//    handler, so a throw past the registry read (runtime detection, host description) ended the process
//    and every worker it owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommsApi } from "../lib/plugins/aify-comms/api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = fs.readFileSync(path.join(ROOT, "bin", "aify-env.mjs"), "utf8");

test("the plugin's request carries the key and refuses to follow a redirect", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new CommsApi({
    endpoint: "http://127.0.0.1:8800",
    credential: async () => "banana",
    identity: { bridgeId: "b-1", bridgeVersion: "0.6.2", bridgeStartedAt: new Date().toISOString() },
    fetchImpl,
  });
  await api.heartbeat({ environmentId: "wsl:test:default", label: "t", cwdRoots: ["/tmp"] }).catch(() => {});
  assert.ok(seen.length >= 1, "a request was made");
  assert.equal(seen[0].options.headers["X-API-Key"], "banana", "the key travels");
  assert.equal(seen[0].options.redirect, "manual", "and never follows a redirect with it");
});

test("the daemon's advertisement fetch refuses to follow a redirect", () => {
  const transport = fs.readFileSync(path.join(ROOT, "lib", "post-advertisement.mjs"), "utf8");
  assert.match(DAEMON, /post: postAdvertisement/);
  const site = transport.indexOf('headers["X-API-Key"] = String(apiKey);');
  assert.ok(site > 0, "the advertisement's key header is where this test expects it");
  const fetchCall = transport.slice(site, site + 500);
  assert.match(fetchCall, /redirect: "manual"/, "the fetch right after it sets redirect: manual");
});

test("an advertisement pass that throws is logged, never an unhandled rejection", () => {
  assert.equal((DAEMON.match(/void advertiseOnce\(\)/g) || []).length, 0, "no bare void advertiseOnce()");
  assert.match(DAEMON, /advertiseOnce\(\)\.catch\(/, "every pass has a catch");
});
