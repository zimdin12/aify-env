#!/usr/bin/env node
// END TO END: a real daemon, a real PTY, a real OutputFollower joining after 64 KB have gone past.
//
// `a-late-subscriber-gets-the-screen.test.js` proves the runner's contract byte for byte. This proves
// the pieces are joined: the route writes the checkpoint meta, the parser reads it, the pane trusts
// it, and a resize afterwards leaves the pane sound. Synthetic output from a generated script.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OutputFollower } from "../lib/output-follower.mjs";
import { terminalSupport } from "../lib/runner.mjs";
import { loadCheckpointFactory } from "../lib/screen-checkpoint.mjs";
import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs");
const LF = String.fromCharCode(10);

function startDaemon() {
  return new Promise((resolve, reject) => {
    const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-env-rec-")), "owned.json");
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: sealedDaemonEnv({ AIFY_ENV_PROCESS_RECORD: record }),
    });
    let output = "";
    const timer = setTimeout(() => reject(new Error(`daemon did not start:\n${output}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ child, base: match[1] });
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
  });
}

async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const post = (url, body) => fetch(url, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  signal: AbortSignal.timeout(10_000),
});

test("a console joining a long-running PTY is handed a sound screen, and a resize keeps it sound", async (t) => {
  if (!terminalSupport().available || !await loadCheckpointFactory()) {
    t.skip("node-pty or the emulator packages are absent here");
    return;
  }
  const { child, base } = await startDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-checkpoint-"));
  const done = path.join(dir, "done");
  fs.writeFileSync(path.join(dir, "gen.js"), `
    const ESC = String.fromCharCode(27);
    let out = "";
    for (let n = 0; n < 2500; n += 1) out += ESC + "[2K\\r" + ESC + "[3" + (n % 7) + "mline " + n + " " + "x".repeat(40) + ESC + "[0m\\r\\n";
    out += ESC + "[5;3HFINAL-MARKER";
    process.stdout.write(out, () => require("fs").writeFileSync(${JSON.stringify(done)}, "1"));
    setInterval(() => {}, 1000);
  `);
  const launcher = path.join(dir, "screen-aify");
  fs.writeFileSync(launcher, ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "gen.js"))}`, ""].join(LF));
  fs.chmodSync(launcher, 0o755);
  let follower = null;
  let id = null;
  try {
    const started = await post(`${base}/processes`, { service: "aify-comms", launcher });
    const body = await started.text();
    assert.equal(started.status, 201, body);
    ({ id } = JSON.parse(body));
    assert.equal(JSON.parse(body).terminal, true, "no PTY, so there is no screen to checkpoint");
    await until(() => fs.existsSync(done), "the generator to finish writing");
    await new Promise((r) => setTimeout(r, 300));

    follower = new OutputFollower({ endpoint: base, id });
    void follower.start();
    await until(() => follower.screen?.rows().some((row) => row.includes("FINAL-MARKER")), "the marker on the rebuilt screen");

    assert.equal(follower.meta.truncated, true, "the replay was complete, so a checkpoint was not needed");
    assert.equal(follower.meta.checkpoint, true, "the daemon did not send a checkpoint");
    assert.equal(follower.paneProblem(), "", "a checkpointed screen was refused");
    assert.equal(follower.screen.rows()[4].indexOf("FINAL-MARKER"), 2, "the marker is not where the process put it");

    assert.equal((await post(`${base}/processes/${encodeURIComponent(id)}/resize`, { cols: 100, rows: 25 })).status, 204);
    await until(() => follower.meta.cols === 100, "the resize meta");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(follower.paneProblem(), "", "a live resize froze the pane");
  } finally {
    follower?.stop();
    if (id) await fetch(`${base}/processes/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    await new Promise((resolve) => { child.on("exit", resolve); child.kill(); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
