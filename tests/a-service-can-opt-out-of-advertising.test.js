// A registry entry may say `"advertise": false`, and this host then sends that service no heartbeat.
//
// WHY IT EXISTS. The daemon advertised to EVERY registry entry with an endpoint (`advertisementTargets`). A service
// that registers so its MCP bridge reaches every session -- aify-dashboard, 2026-10-01 -- is not an environment
// tracker, so it would have received a heartbeat every beat, refused it, and this host would report "not
// advertising" to it for ever. Agreed with aify-comms' owner as an OPT-OUT: absent means advertise, as before, so
// no entry written before this field existed changes behaviour.
//
// ONLY THE BOOLEAN false OPTS OUT. Any other value keeps today's behaviour and is REPORTED, so a field the operator
// wrote is never silently ignored.
//
// ⛔ APPLIED AT THE ADVERTISEMENT PASS, NEVER INSIDE `advertisementTargets`. `pluginCredential` resolves a plugin's
// key through that same helper, and a service that wants no heartbeat may still run a plugin that needs its key.
//
// The last test boots a real daemon against two fake services, one opted out. The opted-out one is a live listener
// that WOULD receive a beat if the opt-out were not wired, so its silence is evidence rather than an empty fixture.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { advertisementTargets, advertisingChoice } from "../lib/advertise.mjs";
import { pluginCredential } from "../lib/plugin-bootstrap.mjs";
import { readServices } from "../lib/services.mjs";
import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs");

const registryText = (services) => JSON.stringify({ version: 1, services });

test("the registry reader carries advertise as written, so the opt-out reaches the daemon", () => {
  // ⛔ The bug this catches: the reader rebuilding each entry from named fields and dropping this one, which is
  // exactly what aify-wrapper's parser does with it. The daemon would then advertise to everyone again.
  const services = readServices(registryText({
    off: { endpoint: "http://off", advertise: false },
    on: { endpoint: "http://on", advertise: true },
    odd: { endpoint: "http://odd", advertise: "no" },
    plain: { endpoint: "http://plain" },
  }));
  const advertise = Object.fromEntries(services.map((s) => [s.name, s.advertise]));
  assert.deepEqual(advertise, { odd: "no", off: false, on: true, plain: undefined });
});

test("only the boolean false opts out; any other value advertises and is reported", () => {
  const services = readServices(registryText({
    off: { endpoint: "http://off", advertise: false },
    on: { endpoint: "http://on", advertise: true },
    odd: { endpoint: "http://odd", advertise: "no" },
    zero: { endpoint: "http://zero", advertise: 0 },
    plain: { endpoint: "http://plain" },
  }));
  const choice = advertisingChoice(services);
  assert.deepEqual(choice.advertised.map((s) => s.name), ["odd", "on", "plain", "zero"]);
  assert.deepEqual(choice.optedOut, ["off"]);
  assert.deepEqual(choice.ignored, ['odd: advertise "no" ignored, advertising', "zero: advertise 0 ignored, advertising"]);
});

test("a service that opts out of heartbeats still resolves a key for its plugin", async () => {
  // ⛔ The bug this catches: the opt-out written inside advertisementTargets, which pluginCredential also uses.
  const [service] = readServices(registryText({ off: { endpoint: "http://off", advertise: false, credentialRef: "off.key" } }));
  let asked = null;
  const key = await pluginCredential(service, async (target) => { asked = target; return { value: "k" }; });
  assert.equal(key, "k");
  assert.equal(asked?.credentialRef, "off.key");
  // And the shared helper itself is unchanged: it still names the opted-out service.
  assert.equal(advertisementTargets([service]).length, 1);
});

/** A listener that counts what reaches it. */
async function listener() {
  const received = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      received.push(request.url);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, environment: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // closeAllConnections first: a daemon's keep-alive socket would otherwise hold close() open after the daemon died.
  return { received, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("a real daemon beats to the neighbour and never to the service that opted out, and says so", async () => {
  const kept = await listener();
  const optedOut = await listener();
  const odd = await listener();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-advertise-optout-"));
  const registry = path.join(scratch, "services.json");
  fs.writeFileSync(registry, registryText({
    "fake-comms": { endpoint: kept.endpoint },
    "fake-dashboard": { endpoint: optedOut.endpoint, advertise: false },
    "fake-odd": { endpoint: odd.endpoint, advertise: "no" },
  }));
  const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: sealedDaemonEnv({
      AIFY_ADVERTISE: "1",
      AIFY_ADVERTISE_MS: "250",
      AIFY_SERVICE_REGISTRY: registry,
      AIFY_ENV_PROCESS_RECORD: path.join(scratch, "owned.json"),
    }),
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    // Three beats to the neighbour: long enough that a beat to the opted-out service would have landed too.
    await new Promise((resolve, reject) => {
      // The poll is cleared on BOTH paths: left running after the deadline, it kept this file's process alive for ever,
      // so a mutation that starved the neighbour hung the run instead of failing it.
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`the neighbour got ${kept.received.length} beats in 30s. Daemon said:\n${output}`));
      }, 30_000);
      const poll = setInterval(() => {
        if (kept.received.length >= 3 && odd.received.length >= 1) { clearInterval(poll); clearTimeout(deadline); resolve(); }
      }, 50);
    });
    assert.ok(kept.received.every((url) => url === "/api/v1/environments/heartbeat"), `unexpected request: ${kept.received}`);
    assert.deepEqual(optedOut.received, [], `the opted-out service was sent ${optedOut.received.length} request(s)`);

    const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(base, `the daemon never said where it listens:\n${output}`);
    const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })).json();
    assert.deepEqual(health.advertiseOptedOut, ["fake-dashboard"], "health does not say which service opted out");
    // A value that is not the boolean false still advertises, and health says it was ignored.
    assert.deepEqual(health.advertiseIgnored, ['fake-odd: advertise "no" ignored, advertising']);
  } finally {
    // A daemon that already exited fires no further "exit", so waiting for one would never end.
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => { child.on("exit", resolve); child.kill(); });
    await kept.close();
    await optedOut.close();
    await odd.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
