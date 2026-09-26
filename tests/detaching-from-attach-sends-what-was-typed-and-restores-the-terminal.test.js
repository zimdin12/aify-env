#!/usr/bin/env node
// Detaching from `aify-env attach` delivers what was already typed, and hands the terminal back clean.
//
// TWO DEFECTS FROM THE v0.7 SCAN, one exit path.
//
// F22: Ctrl+] called `leave()`, which called `process.exit` without waiting for `InputSender` to
// drain -- the method whose own doc says it exists "for a clean detach" had no caller. Keys typed
// just before detaching were lost while a send was in flight, which is the loaded-host case the
// sender was built for, and `post()` swallowed every error so nothing could count the loss.
//
// F10: `restore()` turned raw mode off and wrote nothing else, so whatever the agent had switched on
// -- the alternate screen, a hidden cursor, mouse tracking, bracketed paste -- stayed on in the
// operator's shell.
//
// IT DRIVES THE REAL CLI in a PTY against a fake daemon, as the handshake test beside it does: both
// defects live in the order of statements in `bin/aify-env-attach.mjs`, which a unit test cannot see.

import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "aify-env-attach.mjs");
const DETACH = String.fromCharCode(29);

/** A daemon that answers each keystroke after `inputDelayMs`, recording it on ARRIVAL. */
function slowInputDaemon({ inputDelayMs, output = "" }) {
  const received = [];
  const server = http.createServer((request, response) => {
    const body = [];
    request.on("data", (chunk) => body.push(chunk));
    request.on("end", () => {
      const url = request.url || "";
      if (url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "healthy" }));
        return;
      }
      if (url === "/processes") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ processes: [{ id: "p1", label: "lead", terminal: true }] }));
        return;
      }
      if (url.endsWith("/input")) {
        try { received.push(JSON.parse(Buffer.concat(body).toString("utf8")).data); } catch { /* not ours */ }
        setTimeout(() => { response.writeHead(204); response.end(); }, inputDelayMs);
        return;
      }
      if (url.endsWith("/resize")) { response.writeHead(204); response.end(); return; }
      if (url.endsWith("/output")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (output) response.write(`data: ${JSON.stringify(output)}

`);
        return;
      }
      response.writeHead(404); response.end("{}");
    });
  });
  return { server, received };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attachAndDetach(t, { stream = "" } = {}) {
  const daemon = slowInputDaemon({ inputDelayMs: 200, output: stream });
  await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${daemon.server.address().port}`;
  const pty = createRequire(import.meta.url)("node-pty");
  const child = pty.spawn(process.execPath, [CLI, "--id", "p1"], {
    name: "xterm-color", cols: 80, rows: 24,
    env: { ...process.env, AIFY_ENV_ENDPOINT: endpoint, AIFY_ENV_LOCAL_SOCKET: "0" },
  });
  let output = "";
  let exited = false;
  child.onData((data) => { output += data; });
  child.onExit(() => { exited = true; });
  t.after(async () => {
    try { child.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => daemon.server.close(resolve));
  });

  // Wait for the client to say it is attached, so the keys below go to the sender.
  for (const until = Date.now() + 8000; Date.now() < until && !output.includes("attached to"); ) await wait(25);
  assert.ok(output.includes("attached to"), `the client never attached: ${JSON.stringify(output)}`);

  child.write("abc");        // goes out, and the daemon takes 200 ms to answer it
  await wait(60);
  child.write("def");        // queued behind it
  await wait(30);
  const before = output.length;
  child.write(DETACH);       // detach while "def" is still waiting to be sent
  for (const until = Date.now() + 5000; Date.now() < until && !exited; ) await wait(25);
  await wait(100);
  return { received: daemon.received.join(""), afterDetach: output.slice(before), exited };
}

test("keys typed just before Ctrl+] still reach the process", async (t) => {
  const { received, exited } = await attachAndDetach(t);
  assert.ok(exited, "the client did not exit on Ctrl+]");
  assert.equal(received, "abcdef", `typed "abcdef", the daemon received ${JSON.stringify(received)}`);
});

test("drainedWithin says whether the queue emptied in time, and never waits past its bound", async () => {
  const { InputSender } = await import("../lib/input-sender.mjs");
  const quick = new InputSender(async () => wait(5));
  quick.write("a");
  assert.equal(await quick.drainedWithin(500), true);
  const stuck = new InputSender(() => new Promise(() => {}));
  stuck.write("a");
  const started = Date.now();
  assert.equal(await stuck.drainedWithin(50), false);
  assert.ok(Date.now() - started < 1000, "a dead daemon held the detach");
  assert.equal(await new InputSender(async () => {}).drainedWithin(0), true, "an idle sender is drained");
});

test("detaching turns the cursor back on for the operator's shell", async (t) => {
  // The one mode reset this can observe through ConPTY, which re-renders the stream it carries and
  // does not pass every private mode through. Which modes the leave sequence carries is asserted on
  // the sequence itself, in the test below.
  const { afterDetach } = await attachAndDetach(t);
  assert.ok(afterDetach.includes(`${String.fromCharCode(27)}[?25h`),
    `nothing turned the cursor back on after detaching: ${JSON.stringify(afterDetach)}`);
});

test("the leave sequence resets every mode an agent commonly sets", async () => {
  const { LOCAL_SCREEN_LEAVE } = await import("../lib/attach-screen.mjs");
  const ESC = String.fromCharCode(27);
  // ?1004 (focus reporting) and ?1 (application cursor keys) were missing (v0.7.1 review, E10): an
  // agent that set either left the shell receiving ESC[I and ESC[O on every focus change.
  for (const mode of ["?1049l", "?25h", "?1000l", "?1002l", "?1003l", "?1006l", "?2004l", "?1004l", "?1l", "0m"]) {
    assert.ok(LOCAL_SCREEN_LEAVE.includes(`${ESC}[${mode}`), `the leave sequence does not reset ${mode}`);
  }
  // The keyboard-protocol pop is NOT unconditional: it is owed only for levels the agent pushed.
  // See detaching-pops-only-the-keyboard-levels-the-agent-pushed.test.js (v0.7.1 review, W14).
  assert.ok(!LOCAL_SCREEN_LEAVE.includes(`${ESC}[<`), "the fixed leave sequence pops a level nobody pushed");
});

// ── the keyboard-protocol pop, through the real binary (v0.7.1 review, W14) ────────────────────────
//
// ConPTY carries `CSI < n u` through to this side (observed while writing these), so the pop the
// binary writes on detach can be read here. Which levels it owes is tested on the ledger itself in
// detaching-pops-only-the-keyboard-levels-the-agent-pushed.test.js; these prove the binary writes it.

test("detaching pops a keyboard level the agent pushed", async (t) => {
  const ESC = String.fromCharCode(27);
  const { afterDetach } = await attachAndDetach(t, { stream: `hi${ESC}[>1uthere` });
  assert.ok(afterDetach.includes(`${ESC}[<1u`), `the pushed level was not popped: ${JSON.stringify(afterDetach)}`);
});

test("detaching pops nothing when the agent pushed nothing", async (t) => {
  const ESC = String.fromCharCode(27);
  const { afterDetach } = await attachAndDetach(t, { stream: "hithere" });
  assert.ok(afterDetach.includes(`${ESC}[?25h`), `positive control: nothing was restored at all: ${JSON.stringify(afterDetach)}`);
  assert.ok(!afterDetach.includes(`${ESC}[<`), `a level nobody pushed was popped: ${JSON.stringify(afterDetach)}`);
});
