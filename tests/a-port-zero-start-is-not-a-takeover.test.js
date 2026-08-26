#!/usr/bin/env node
// An instance on an EPHEMERAL port supersedes nothing, so it must reap nothing.
//
// THE INCIDENT, 2026-08-26, reproduced three times against the operator's live fleet. An aify-comms
// test started this daemon with `--port 0` and no `AIFY_ENV_PROCESS_RECORD`, so the record defaulted
// to the shared file the RUNNING instance was using. The new daemon read it, found every process alive
// and verifiably ours, killed each tree, and emptied the file. Each time a pair of managed workers
// died three seconds apart.
//
// WHY THE EXISTING PROTECTION DID NOT APPLY. `a-second-start-supersedes-the-first.test.js` pins the
// case this file is NOT about: a second start on the SAME port takes over, and reaping the
// predecessor's processes is then correct -- the operator's own ruling. That safety rests on holding
// the port proving nobody else is serving. `--port 0` gets an ephemeral port, which is always free, so
// the proof evaporates: the instance holds a port, serves nothing anybody asked for, and reaps a live
// environment's entire fleet.
//
// TWO THINGS MUST HOLD, and this file exists because only fixing the first would look like success:
//   * the incumbent's processes stay alive, and
//   * their RECORD stays too. Sparing a process and then deleting the note that it exists leaves it
//     unreapable the moment the incumbent is hard-killed -- the leak the record was built to prevent.
//
// A REAL DAEMON AND A REAL PROCESS, because the bug lived in the wiring. The pure decision is covered
// by a-live-owners-processes-are-not-orphans.test.js; a green run there says nothing about whether
// `bin/aify-env.mjs` passes the probe, and passing it is the whole fix.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("a --port 0 start leaves a running instance's processes AND its record alone", async () => {
  const PORT = 8886;
  const box = sealed("portzero");
  const launcher = longLauncher(box.dir);
  const incumbent = start(box.env(box.record), PORT);
  let ephemeral = null;
  try {
    await waitFor(incumbent, /listening/);
    const created = await fetch(`http://127.0.0.1:${PORT}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "test", launcher, args: [], cwd: box.dir }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(created.status, 201, `could not start a process: ${created.status}`);
    const { pid } = await created.json();

    // ANTI-VACUITY, both halves. A test that runs against nothing alive, or against an empty record,
    // passes whatever the daemon does.
    assert.ok(alive(pid), "nothing was running, so this test would prove nothing");
    const before = JSON.parse(fs.readFileSync(box.record, "utf8"));
    assert.equal(before.length, 1, "the record did not describe the running process");
    assert.equal(before[0].owner, incumbent.pid, "the record does not say which instance owns it");

    // The incident: same record file, ephemeral port.
    ephemeral = start(box.env(box.record), 0);
    await waitFor(ephemeral, /listening/);
    // Give the reap the same room the superseding test gives it, so a slow kill is not read as no kill.
    for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 200));

    assert.ok(alive(pid), "a --port 0 instance reaped a running environment's process");
    const after = JSON.parse(fs.readFileSync(box.record, "utf8"));
    assert.equal(after.length, 1, "the incumbent's record was emptied, so its process is now unreapable");
    assert.equal(after[0].pid, pid, "the record was rewritten with something other than the live entry");
    assert.equal(after[0].owner, incumbent.pid, "the kept entry lost the owner that protects it");
  } finally {
    if (ephemeral) ephemeral.kill();
    incumbent.kill();
  }
});

test("the ephemeral instance says it left the process alone, and names the owner", async () => {
  // Silence would be indistinguishable from having found nothing. An operator debugging a leak needs
  // to know the reaper SAW the entry and declined it.
  const PORT = 8887;
  const box = sealed("portzero-says");
  const launcher = longLauncher(box.dir);
  const incumbent = start(box.env(box.record), PORT);
  let ephemeral = null;
  try {
    await waitFor(incumbent, /listening/);
    const created = await fetch(`http://127.0.0.1:${PORT}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "test", launcher, args: [], cwd: box.dir }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(created.status, 201, `could not start a process: ${created.status}`);

    ephemeral = start(box.env(box.record), 0);
    const output = await waitFor(ephemeral, /left pid \d+ .* is still running/);
    assert.match(output, new RegExp(`owner \\(pid ${incumbent.pid}\\) is still running`));
  } finally {
    if (ephemeral) ephemeral.kill();
    incumbent.kill();
  }
});
