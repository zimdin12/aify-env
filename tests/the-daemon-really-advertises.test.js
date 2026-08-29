// The wiring, executed. Not the builders — those are `advertise.test.js` — but the call site.
//
// WHY A REAL BOOT. `node --check` parses; it does not bind names. The first attempt at this wiring
// referenced ten identifiers that did not exist and parsed clean, and the second wrote `BUILD.build`
// where `BUILD` is a string, so `instance` would have travelled as `undefined` on every beat. Neither
// is visible from the module's text, from its own tests, or from a syntax check. Both are visible the
// moment the daemon runs and something reads what it sent.
//
// WHAT IS SEALED, and why each one. `AIFY_SERVICE_REGISTRY` points at a temp registry naming a fake
// service in this file, so nothing reaches the operator's real aify-comms. `AIFY_ENV_PROCESS_RECORD`
// points at a temp file, because the daemon REAPS FROM THE RECORD once it holds the port and the
// real record names live agents. `--port 0` takes an ephemeral port, so this cannot supersede a
// daemon already serving 8802. `AIFY_NO_DASHBOARD` keeps the screen out of the captured output.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = path.join(ROOT, "bin", "aify-env.mjs");

/** A service that records what it was told and answers the way aify-comms does. */
function fakeService() {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ url: request.url, body: body === "" ? null : JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, environment: {} }));
    });
  });
  return { server, received };
}

async function advertisementFromARealDaemon() {
  const { server, received } = fakeService();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-advertise-"));
  const registry = path.join(scratch, "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "fake-comms": { endpoint } } }));

  const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIFY_ADVERTISE: "1",
      AIFY_ADVERTISE_MS: "250",
      AIFY_SERVICE_REGISTRY: registry,
      AIFY_ENV_PROCESS_RECORD: path.join(scratch, "owned.json"),
      AIFY_NO_DASHBOARD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`no advertisement arrived within 20s. Daemon said:\n${output}`)),
        20_000,
      );
      const poll = setInterval(() => {
        if (received.length > 0) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 50);
    });
    return { sent: received[0], output };
  } finally {
    child.kill();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test("a booted daemon posts an advertisement to every registered service", async () => {
  const { sent, output } = await advertisementFromARealDaemon();
  assert.equal(sent.url, "/api/v1/environments/heartbeat",
    `the advertisement went to the wrong route. Daemon said:\n${output}`);

  const body = sent.body;
  // Every field the payload builder claims to fill, checked for a VALUE rather than a key. This is
  // where `BUILD.build` would have shown up: the key was always present, and always `undefined`.
  for (const field of ["hostname", "kind", "os", "machineId", "label"]) {
    assert.equal(typeof body[field], "string", `${field} is not a string`);
    assert.notEqual(body[field].trim(), "", `${field} arrived empty`);
  }
  assert.equal(typeof body.metadata.instance, "string");
  assert.notEqual(body.metadata.instance, "", "instance arrived empty — a build identity that is not one");
  assert.equal(body.metadata.advertiser, "aify-env");
});

test("it sends NO id and NO cwdRoots, which are the two the service owns", async () => {
  const { sent } = await advertisementFromARealDaemon();
  assert.ok(!("id" in sent.body), "the daemon built an environment id");
  assert.ok(!("cwdRoots" in sent.body),
    "the daemon claimed a roots policy it does not own, which erases the configured roots");
});

test("the runtimes it advertises are the wrappers actually installed on this host", async () => {
  const { sent } = await advertisementFromARealDaemon();
  assert.ok(Array.isArray(sent.body.runtimes), "runtimes is not a list");
  for (const row of sent.body.runtimes) {
    assert.equal(typeof row.runtime, "string");
    assert.equal(typeof row.available, "boolean");
    // No capability flags: those describe how a SERVICE drives a runtime, not what a host has.
    assert.ok(!("capabilities" in row), `${row.runtime} carried service-side capability flags`);
    assert.ok(!("modes" in row), `${row.runtime} carried service-side modes`);
  }
  // Every advertised row is available by construction — the detector only reports wrappers it found —
  // so terminalRuntimes must match it exactly rather than being a second list to keep in step.
  assert.deepEqual(
    sent.body.terminalRuntimes,
    sent.body.runtimes.filter((row) => row.available).map((row) => row.runtime),
  );
});
