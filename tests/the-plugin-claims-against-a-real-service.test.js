// The whole claim path, end to end, against a service that really answers over HTTP.
//
// WHY THIS EXISTS ALONGSIDE THE UNIT TESTS. Every piece of this was proven with fakes: the API
// client with a fake fetch, the claim pass with a fake api, the plugin with both. That leaves the
// JOINS unproven -- and the joins are where this project's defects live. The three that Phase 8's
// first real spawn exposed were all joins between components that each reported healthy: argv never
// reaching the spawn, Windows resolving a launcher to a `.cmd` shim the runner refuses, and a
// launcher path losing every backslash before bash. No unit test could have seen one of them.
//
// SO THIS USES: a real HTTP server speaking the service's protocol, the real `CommsApi` over a real
// socket, the real claim pass, and the real `Runner` starting a real process. The only thing that is
// not real is aify-comms itself.
//
// IT TOUCHES NOTHING THE OPERATOR OWNS. The stub binds an ephemeral port on loopback, the process it
// starts is `node -e` printing a line, and the runner writes its record into a temp directory. No
// registry, no credential store, no environment row, and nothing that could supersede a running
// daemon -- starting shared infrastructure to test it has cost this project a live fleet twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runner } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses } from "../lib/service-plugins.mjs";
import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";

/**
 * A stand-in for aify-comms that speaks only the three calls the plugin makes.
 *
 * It hands out ONE spawn request and then answers empty, the way a real service does once its queue
 * drains -- so the test proves a claim happens without the loop finding endless work.
 */
function stubService({ request }) {
  const seen = { heartbeats: [], claims: 0, reports: [] };
  let handedOut = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      const reply = (code, value) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url.endsWith("/environments/heartbeat")) {
        seen.heartbeats.push({ payload, apiKey: req.headers["x-api-key"] || "" });
        return reply(200, { ok: true });
      }
      if (req.url.endsWith("/spawn-requests/claim")) {
        seen.claims += 1;
        if (handedOut) return reply(200, {});
        handedOut = true;
        return reply(200, { spawnRequest: request });
      }
      if (req.url.includes("/spawn-requests/")) {
        seen.reports.push(payload);
        return reply(200, { ok: true });
      }
      return reply(404, { detail: "not found" });
    });
  });
  return { server, seen };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("a spawn request becomes a running process, with only aify-env involved", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aify-env-e2e-"));
  const ownedFile = join(workspace, "owned.json");
  // A REAL LAUNCHER, because the allowlist judges a launcher by its CONTENTS: a shebang declaring
  // the interpreter, and a HARNESS_WRAPPER_VERSION marker, since enrolment is by carrying the
  // contract rather than by being named in a list. The first version of this test used node.exe and
  // got "starting, failed" -- the allowlist correctly refusing a binary, which is precisely the
  // join a fake runner cannot show.
  const launcher = writeLauncher(workspace);
  const request = {
    id: "req-e2e-1",
    agentId: "e2e-agent",
    workspace,
    launcher,
    args: [],
  };
  const { server, seen } = stubService({ request });
  const endpoint = await listen(server);

  const runner = new Runner({ ownedFile });
  const logs = [];
  const plugin = createCommsPlugin({
    endpoint,
    version: "0.6.1-test",
    advertisement: async () => ({ hostname: "e2e-host", kind: "windows" }),
    cwdRoots: async () => [workspace],
    windows: process.platform === "win32",
  });
  const host = new PluginHost({
    processes: new PluginProcesses(runner),
    credential: async () => "e2e-key",
    log: (m) => logs.push(m),
  });

  try {
    await plugin.start(host);
    // Wait for the claim to be reported RUNNING rather than for a fixed delay: a sleep long enough
    // to be reliable here is a sleep that makes the suite slow, and one short enough to be fast is
    // the "flaky" test this project keeps having to explain.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.reports.some((r) => r.status === "running")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // THE HEARTBEAT CARRIED A BRIDGE ID. Without it the service stamps no `bridgeLastSeen`, `/spawn`
    // refuses, and this whole path is unreachable -- which is precisely the state the operator's
    // machine was in for a day while every component reported healthy.
    assert.ok(seen.heartbeats.length >= 1, "the plugin never registered as a claimer");
    assert.ok(seen.heartbeats[0].payload.bridgeId, "the heartbeat carried no bridgeId");
    assert.equal(seen.heartbeats[0].apiKey, "e2e-key", "the credential did not reach the wire");

    // AND THE CLAIM BECAME A PROCESS.
    const statuses = seen.reports.map((r) => r.status);
    assert.ok(statuses.includes("starting"), `never reported starting: ${JSON.stringify(statuses)}`);
    assert.ok(statuses.includes("running"), `never reported running: ${JSON.stringify(statuses)}`);
    const running = seen.reports.find((r) => r.status === "running");
    assert.ok(running.handle, "the service was given no handle, so it can never write to or stop this agent");
    assert.ok(running.processId, "no pid was reported");
    assert.ok(running.bridgeId, "the report did not say which claimer owns the work");
  } finally {
    await plugin.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a request outside the advertised roots is refused over the wire, and nothing starts", async () => {
  // The guard that stops a service launching a process anywhere on the host, proven through the real
  // client rather than against the pure function alone.
  const workspace = mkdtempSync(join(tmpdir(), "aify-env-e2e-guard-"));
  const request = {
    id: "req-e2e-2",
    agentId: "e2e-outside",
    workspace: join(tmpdir(), "somewhere-else-entirely"),
    launcher: writeLauncher(workspace),
    args: [],
  };
  const { server, seen } = stubService({ request });
  const endpoint = await listen(server);

  const runner = new Runner({ ownedFile: join(workspace, "owned.json") });
  const started = [];
  const processes = new PluginProcesses(runner);
  const watched = { ...processes, start: async (spec) => { started.push(spec); return processes.start(spec); } };

  const plugin = createCommsPlugin({
    endpoint,
    advertisement: async () => ({ hostname: "e2e-host", kind: "windows" }),
    cwdRoots: async () => [workspace],
    windows: process.platform === "win32",
  });
  const host = new PluginHost({
    processes: Object.assign(Object.create(PluginProcesses.prototype), watched),
    credential: async () => "k",
  });

  try {
    await plugin.start(host);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.reports.some((r) => r.status === "failed")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = seen.reports.find((r) => r.status === "failed");
    assert.ok(failed, `never reported a refusal: ${JSON.stringify(seen.reports)}`);
    assert.match(failed.error, /outside this environment/);
    assert.deepEqual(started, [], "a process was launched outside the advertised roots");
  } finally {
    await plugin.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});

/** A launcher the allowlist accepts: shebang plus the harness marker, exiting on its own so a
 *  failing test can leave nothing behind. */
function writeLauncher(dir) {
  const path = join(dir, "e2e-launcher.sh");
  const NEWLINE = String.fromCharCode(10);
  const script = [
    "#!/usr/bin/env bash",
    'HARNESS_WRAPPER_VERSION="0.0.0-e2e"',
    'echo "started by aify-env"',
    "",
  ].join(NEWLINE);
  writeFileSync(path, script, { encoding: "utf8" });
  chmodSync(path, 0o755);
  return path;
}
