// The guard, against a REAL daemon. The predicate is proven next door; this is whether it is reached.
//
// A HELPER WITH GREEN TESTS AND NO CALL SITE IS A FEATURE THAT CANNOT FIRE, and this repo's sibling
// has shipped exactly that. So these send the actual bytes a browser would send, over a socket, to a
// server that is running, and read the status that comes back.
//
// The attack under test, spelled out: `POST /processes` with `content-type: text/plain` and a JSON
// body is a CORS SIMPLE REQUEST. No preflight is sent, so nothing asks this daemon for permission
// first; the body is `JSON.parse`d whatever type it claims; and the attacker never needs to read the
// response because the harm is that the process started.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = path.join(ROOT, "bin", "aify-env.mjs");

let daemon = null;
let endpoint = "";
let scratch = "";

test("start a real daemon on an ephemeral port", async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-csrf-"));
  daemon = spawn(process.execPath, [DAEMON, "--port", "0"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIFY_NO_DASHBOARD: "1",
      // A SCRATCH RECORD. The daemon reaps from this file once it holds the port, and the real one
      // names the operator's live agents.
      AIFY_ENV_PROCESS_RECORD: path.join(scratch, "owned.json"),
      // No advertising: this test is about the door, and posting to the real registry's services is
      // not something a test may do.
      AIFY_ADVERTISE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  endpoint = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`daemon did not start:\n${output}`)), 20_000);
    const onData = (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(deadline);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    daemon.stdout.on("data", onData);
    daemon.stderr.on("data", onData);
  });
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("a program can still reach it — the control that makes the refusals mean something", async () => {
  const response = await fetch(`${endpoint}/health`);
  assert.equal(response.status, 200, "the guard refused the only real kind of caller");
  const health = await response.json();
  assert.equal(typeof health.version, "string");
});

test("the simple-request attack is refused", async () => {
  // Exactly what a page can send with no preflight: a text/plain POST carrying JSON.
  const response = await fetch(`${endpoint}/processes`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "no-cors",
    },
    body: JSON.stringify({ service: "evil", launcher: "C:/anything/claude-aify", args: [] }),
  });
  assert.equal(response.status, 403, "a page was allowed to ask this daemon to start a process");
  const refusal = await response.json();
  assert.match(refusal.error, /evil\.example/, "the refusal did not say what it refused");
});

test("the refusal happens BEFORE the launcher is even looked at", async () => {
  // A 403 that came from the allowlist would be a different guard doing the work, and would go away
  // the moment a page named a wrapper that IS installed. The message has to be this guard's.
  const response = await fetch(`${endpoint}/processes`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ service: "evil", launcher: "/definitely/not/here", args: [] }),
  });
  assert.equal(response.status, 403);
  const refusal = await response.json();
  assert.match(refusal.error, /Origin/, `the allowlist answered instead of the transport: ${refusal.error}`);
  assert.doesNotMatch(refusal.error, /cannot read/);
});

test("a browser DELETE cannot stop a running process", async () => {
  const response = await fetch(`${endpoint}/processes/anything`, {
    method: "DELETE",
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(response.status, 403);
});

test("reading /health from a browser TAB still works", async () => {
  // A direct navigation, which is what an operator opening the endpoint looks like. Refusing this
  // would trade a real convenience for nothing: a navigation cannot POST.
  const response = await fetch(`${endpoint}/health`, {
    headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
  });
  assert.equal(response.status, 200);
});

test("stop the daemon", async () => {
  daemon?.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(scratch, { recursive: true, force: true });
});
