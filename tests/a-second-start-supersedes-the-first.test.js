#!/usr/bin/env node
// Starting `aify-env` when one is already running takes over, and takes the old one's work with it.
//
// Operator ruling, 2026-08-25: "it should kill another bridge and switch over to new process." The
// aify-comms environment bridge already behaves that way, and a second environment refusing to start
// was the odd one out.
//
// TWO THINGS HAD TO BE TRUE FOR THAT TO BE SAFE, and only one of them was:
//
//   * The predecessor's processes must not be stranded. They are in the on-disk record, and the
//     replacement reaps from it -- but only AFTER the port is its own, which is the ordering fix
//     below.
//
//   * The reap must not run before the port is claimed. It did, and that was a real bug: a second
//     start read the record of the instance already RUNNING, found its processes alive and verifiably
//     ours, killed them as orphans, and only then discovered the port was taken and exited. The
//     incumbent kept serving, robbed. Proven with a real process before the fix.
//
// And the holder is ASKED before it is killed. Ending whatever happens to hold a port is how you stop
// somebody else's server, so a holder that does not identify as an aify-env is left alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "aify-env.mjs");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function sealed(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-${label}-`));
  return {
    dir,
    record: path.join(dir, "owned.json"),
    env: (record) => ({
      ...process.env,
      AIFY_ENV_PROCESS_RECORD: record,
      AIFY_SERVICE_REGISTRY: path.join(dir, "no-registry.json"),
      AIFY_NO_DASHBOARD: "1",
    }),
  };
}

function longLauncher(dir) {
  const file = path.join(dir, "long-aify");
  fs.writeFileSync(file, ["#!/usr/bin/env bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', "sleep 120", ""]
    .join(String.fromCharCode(10)));
  return file;
}

const start = (env, port) =>
  spawn(process.execPath, [ENTRY, "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });

function waitFor(child, pattern, ms = 20000) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`never saw ${pattern}: ${seen}`)), ms);
    const onData = (chunk) => {
      seen += chunk.toString();
      if (pattern.test(seen)) { clearTimeout(timer); resolve(seen); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

test("a second start takes over, and the first stops serving", async () => {
  const PORT = 8885;
  const box = sealed("supersede");
  const first = start(box.env(box.record), PORT);
  let second = null;
  try {
    await waitFor(first, /listening/);
    second = start(box.env(box.record), PORT);
    await waitFor(second, /superseding/);
    await waitFor(second, /listening/);

    // The predecessor is gone and the replacement is serving on the same port.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(!alive(first.pid), "the superseded instance is still running");
    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(8000),
    })).json();
    assert.equal(health.status, "healthy");
    assert.equal(health.pid, second.pid, "/health does not report the process that is actually serving");
  } finally {
    if (second) second.kill();
    first.kill();
  }
});

test("the predecessor's processes are reaped by the replacement, not stranded", async () => {
  const PORT = 8884;
  const box = sealed("adopt");
  const launcher = longLauncher(box.dir);
  const first = start(box.env(box.record), PORT);
  let second = null;
  try {
    await waitFor(first, /listening/);
    const created = await fetch(`http://127.0.0.1:${PORT}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "test", launcher, args: [], cwd: box.dir }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(created.status, 201, `could not start a process: ${created.status}`);
    const { pid } = await created.json();
    assert.ok(alive(pid), "nothing was running, so this test would prove nothing");

    second = start(box.env(box.record), PORT);
    await waitFor(second, /listening/);
    // The replacement reaps from the record once the port is its own.
    for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 200));

    assert.ok(!alive(pid), "the predecessor's process was left running with nobody owning it");
  } finally {
    if (second) second.kill();
    first.kill();
  }
});

test("something that is not an aify-env is left alone, and named", async () => {
  // The whole reason the holder is asked rather than just killed.
  const PORT = 8883;
  const stranger = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("not an environment");
  });
  await new Promise((resolve) => stranger.listen(PORT, "127.0.0.1", resolve));
  const box = sealed("stranger");
  const child = start(box.env(box.record), PORT);
  try {
    const output = await waitFor(child, /not an aify-env/);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 69);
    assert.match(output, /left alone/);
    assert.ok(stranger.listening, "the stranger's server was stopped");
  } finally {
    child.kill();
    await new Promise((resolve) => stranger.close(resolve));
  }
});
