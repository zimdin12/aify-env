#!/usr/bin/env node
// A non-ASCII keystroke must reach the process as the bytes that were typed, not as more of them.
//
// EXTERNAL REVIEW, 2026-09-21, finding E, PRE-EXISTING. `aify-env attach` reads stdin raw and puts
// the bytes on the wire as a latin1 string -- one code unit per byte, which is the only decode that
// survives a multi-byte character split across two chunks. The daemon then handed that string to a
// writer that encodes UTF-8, so every byte above 0x7F was encoded a second time.
//
// MEASURED against the real node-pty on this host, with the child reporting its own stdin in hex:
//
//   typed e-acute  want c3a9   got c383c2a9   CORRUPT
//   typed yen      want c2a5   got c382c2a5   CORRUPT
//   typed a        want 61     got 61         OK        <- the control, and why this lived so long
//
// A Buffer of the same bytes arrived intact in the same run, which is the fix: the frame now says
// what its `data` IS, and only the caller knows that. The dashboard console sends TEXT that was
// already decoded from JSON, and it must keep travelling as text -- so an absent `encoding` still
// means exactly what it meant before, and that case is a control here rather than an afterthought.

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { WIRE_ENCODINGS, inputPayload } from "../lib/input-encoding.mjs";
import { Runner } from "../lib/runner.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env-attach.mjs");

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

/** A child that reports its own stdin in hex, so no terminal echo has to be interpreted. */
const reportsItsStdin = () => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", "process.stdin.on('data', (b) => process.stdout.write('HEX:' + b.toString('hex') + ';')); setTimeout(() => {}, 5000)"],
});

/** Exactly what bin/aify-env-attach.mjs puts on the wire for a typed character. */
const asAttachSendsIt = (text) => Buffer.from(text, "utf8").toString("binary");

const until = async (predicate, ms = 4000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

test("the wire says what its bytes are, and an older caller still means text", () => {
  assert.deepEqual(inputPayload({ data: "hi" }), { ok: true, value: "hi" },
    "no encoding is what every caller before this sent, and it must not change meaning");
  const bytes = inputPayload({ data: asAttachSendsIt("é"), encoding: "binary" });
  assert.ok(Buffer.isBuffer(bytes.value));
  assert.equal(bytes.value.toString("hex"), "c3a9", "the bytes that were typed, and no more of them");
  assert.equal(inputPayload({ data: "x", encoding: "utf8" }).value, "x");
  // A name nobody implements is refused rather than guessed at: a silently ignored encoding is how
  // this defect would come back on a future transport.
  assert.match(inputPayload({ data: "x", encoding: "utf-16" }).error, /unknown input encoding/);
  assert.match(inputPayload({ data: 7, encoding: "binary" }).error, /string `data`/);
  assert.deepEqual(Object.keys(WIRE_ENCODINGS), ["utf8", "binary"]);
});

test("a typed e-acute reaches a real process as c3a9", async (t) => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(reportsItsStdin());
  t.after(() => { try { runner.stop(handle.id); } catch { /* going away anyway */ } });
  const seen = [];
  handle.onOutput((chunk) => seen.push(chunk));

  const post = (body) => handleRequest(
    { method: "POST", path: `/processes/${encodeURIComponent(handle.id)}/input`, body },
    { runner },
  );

  // THE CONTROL FIRST, in the same run: ASCII was never affected, so a probe that cannot show it
  // arriving is broken and says nothing about the character that follows.
  await post({ data: asAttachSendsIt("a"), encoding: "binary" });
  assert.ok(await until(() => seen.join("").includes("HEX:61;")), `ASCII never arrived: ${seen.join("")}`);

  seen.length = 0;
  await post({ data: asAttachSendsIt("é"), encoding: "binary" });
  assert.ok(await until(() => seen.join("").includes("HEX:c3a9;")),
    `e-acute arrived as something else: ${JSON.stringify(seen.join(""))}`);
  assert.ok(!seen.join("").includes("c383c2a9"), "double-encoded is the defect, not a near miss");
});

test("the dashboard's text still travels as text", async (t) => {
  // The other caller of this route sends a JS string decoded from JSON, with no bytes behind it.
  // Writing THAT as latin1 would corrupt it the opposite way, so the absent-encoding path is not a
  // leftover: it is the correct behaviour for everything that is not a raw stdin.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(reportsItsStdin());
  t.after(() => { try { runner.stop(handle.id); } catch { /* going away anyway */ } });
  const seen = [];
  handle.onOutput((chunk) => seen.push(chunk));

  await handleRequest(
    { method: "POST", path: `/processes/${encodeURIComponent(handle.id)}/input`, body: { data: "é" } },
    { runner },
  );
  assert.ok(await until(() => seen.join("").includes("HEX:c3a9;")),
    `text should be encoded once, as it always was: ${JSON.stringify(seen.join(""))}`);
});

test("an encoding this daemon does not implement is refused, not written", async (t) => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(reportsItsStdin());
  t.after(() => { try { runner.stop(handle.id); } catch { /* going away anyway */ } });
  const seen = [];
  handle.onOutput((chunk) => seen.push(chunk));

  const response = await handleRequest(
    { method: "POST", path: `/processes/${encodeURIComponent(handle.id)}/input`, body: { data: "x", encoding: "base64" } },
    { runner },
  );
  assert.equal(response.status, 400);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(seen.join(""), "", "a frame that was refused must not also have been written");
});

test("the real client SAYS its bytes are bytes", async (t) => {
  // A DECLARED FIELD WITH NO WRITER CHANGES NOTHING. Everything above proves the daemon honours
  // `encoding`; this proves the one client that needs it actually sends it, by driving the real CLI
  // through a terminal and reading the body off the wire. Without this the whole fix could be
  // green and the defect still shipped.
  const bodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url || "";
      if (url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "healthy", inputSocket: "" }));
        return;
      }
      if (url === "/processes") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ processes: [{ id: "p1", label: "lead", terminal: true }] }));
        return;
      }
      if (url.endsWith("/input")) {
        try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* not ours */ }
        response.writeHead(204); response.end();
        return;
      }
      if (url.endsWith("/output")) { response.writeHead(200, { "content-type": "text/event-stream" }); return; }
      response.writeHead(204); response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  // A REAL TERMINAL, because the client refuses anything else -- without raw mode there are no
  // per-keystroke bytes to get the encoding wrong about.
  const pty = createRequire(import.meta.url)("node-pty");
  const child = pty.spawn(process.execPath, [CLI, "--id", "p1"], {
    name: "xterm-color", cols: 80, rows: 24,
    env: { ...process.env, AIFY_ENV_ENDPOINT: endpoint, AIFY_ENV_LOCAL_SOCKET: "0" },
  });
  t.after(async () => {
    try { child.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => server.close(resolve));
  });
  child.onData(() => {});

  child.write("é");
  const until = Date.now() + 6000;
  while (Date.now() < until && !bodies.length) await new Promise((resolve) => setTimeout(resolve, 25));

  assert.ok(bodies.length, "the client sent nothing at all");
  assert.equal(bodies[0].encoding, "binary", `the body must declare its encoding: ${JSON.stringify(bodies[0])}`);
  // And the two halves have to agree: the string it sent, decoded the way it said, is the typed bytes.
  assert.equal(Buffer.from(bodies[0].data, "latin1").toString("hex"), "c3a9");
});
