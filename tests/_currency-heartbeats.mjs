// Exercise the daemon's real bootstrap and both HTTP senders against a test-owned receiver.
// Copy package sources before changing disk identity. Never edit the checkout or use live state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export async function captureCurrencyHeartbeats({ advertise = true } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-currency-"));
  const pkg = path.join(scratch, "package");
  fs.mkdirSync(pkg);
  for (const name of ["bin", "lib", "package.json", "VERSION", "README.md"]) {
    fs.cpSync(path.join(ROOT, name), path.join(pkg, name), { recursive: true });
  }
  const received = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (req.url === "/api/v1/environments/heartbeat") received.push(body);
    // No work, controls or agents are ever handed to this daemon.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, environment: {},
      ...(body.bridgeId ? { claimer: { accepted: true, bridgeId: body.bridgeId } } : {}) }));
  });
  let child;
  let exited;
  let output = "";
  async function until(predicate, label, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `${label} timed out; daemon output:\n${output}`);
      assert.ok(!child || child.exitCode === null, `daemon exited: ${output}`);
      await pause(25);
    }
  }
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const registry = path.join(scratch, "services.json");
    fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-comms": { endpoint } } }));
    // Allowlisted parent variables only. Registry, credentials/home, process record and ports
    // belong to this test. There is no route from the test to the operator's service or fleet.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
    Object.assign(env, {
      HOME: scratch, USERPROFILE: scratch, TEMP: scratch, TMP: scratch,
      AIFY_ADVERTISE: advertise ? "1" : "0", AIFY_ADVERTISE_MS: "250",
      AIFY_SERVICE_REGISTRY: registry, AIFY_ENV_PROCESS_RECORD: path.join(scratch, "owned.json"),
      AIFY_NO_DASHBOARD: "1",
    });
    child = spawn(process.execPath, [path.join(pkg, "bin", "aify-env.mjs"), "--port", "0"], {
      cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"],
    });
    exited = once(child, "exit");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const pluginBeats = () => received.filter((body) => body.bridgeId);
    await until(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output)
      && pluginBeats().length > 0 && (!advertise || received.some((body) => !body.bridgeId)),
    "startup heartbeats");
    const base = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)[1];
    const health = async () => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      const value = await response.json();
      return { build: value.build, codeOnDisk: value.codeOnDisk };
    };
    const before = await health();
    assert.ok(before.build && before.codeOnDisk, "test daemon has no comparable source identities");
    assert.equal(before.build, before.codeOnDisk, "fresh package already differs");
    const first = pluginBeats()[0];
    const advertisement = received.find((body) => !body.bridgeId) || null;
    const firstCount = pluginBeats().length;
    fs.appendFileSync(path.join(pkg, "lib", "advertise.mjs"), "\n// Test-owned package-source change.\n");
    let after;
    const deadline = Date.now() + 15_000;
    do {
      after = await health();
      if (after.codeOnDisk !== before.codeOnDisk) break;
      assert.ok(Date.now() < deadline, "disk identity never changed after test-owned source edit");
      await pause(100);
    } while (true);
    assert.equal(after.build, before.build, "editing disk changed the startup identity");
    await until(() => pluginBeats().length > firstCount, "second plugin heartbeat", 35_000);
    const second = pluginBeats().at(-1);
    return { before, after, first, second, advertisement };
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (exited) await exited;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
