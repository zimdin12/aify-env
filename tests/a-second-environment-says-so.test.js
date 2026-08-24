#!/usr/bin/env node
// Running `aify-env` when one is already running says so, in a sentence.
//
// Before this, the most likely mistake anyone makes with this command -- running it twice -- killed
// the process on an unhandled 'error' event and printed a Node stack trace:
//
//   Error: listen EADDRINUSE: address already in use 127.0.0.1:8802
//       at Server.setupListenHandle [as _listen2] (node:net:1940:16)
//       ...
//
// The remedy is obvious once stated and invisible in a trace, and an operator meeting that dump has no
// reason to conclude that an environment is already up and serving perfectly well. It happened to the
// operator of this fleet, on the release host, because a detached instance held the port.
//
// Exit 69 (EX_UNAVAILABLE), not 1: a supervisor restarting on failure must not fight the instance that
// already holds the port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "aify-env.mjs");
const PORT = 8887;

function sealedEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-second-"));
  return {
    ...process.env,
    // Never the real record: a test instance reading it would reap the operator's processes at start.
    AIFY_ENV_PROCESS_RECORD: path.join(dir, "owned.json"),
    AIFY_SERVICE_REGISTRY: path.join(dir, "no-registry.json"),
    AIFY_NO_DASHBOARD: "1",
  };
}

function run(env) {
  return spawn(process.execPath, [ENTRY, "--port", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
}

async function collect(child) {
  let out = "";
  child.stdout.on("data", (c) => { out += c.toString(); });
  child.stderr.on("data", (c) => { out += c.toString(); });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { out, code };
}

test("the second instance explains itself and exits 69, without a stack trace", async () => {
  const first = run(sealedEnv());
  try {
    // Wait for the port to be genuinely held, or the second start proves nothing.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the first instance never listened")), 15000);
      first.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("listening")) { clearTimeout(timer); resolve(); }
      });
    });

    const { out, code } = await collect(run(sealedEnv()));
    assert.equal(code, 69, `expected EX_UNAVAILABLE, got ${code}: ${out}`);
    assert.match(out, /already running/);
    assert.match(out, new RegExp(String(PORT)), "the message must name the port it could not take");
    assert.match(out, /aify-env tui/, "it must say how to see the one that is running");
    // The whole point: a condition with a known remedy must not arrive as a trace.
    assert.ok(!/at Server\.|node:net:|Unhandled 'error'/.test(out), `a stack trace reached the operator:\n${out}`);
  } finally {
    first.kill();
  }
});
