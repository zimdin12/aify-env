#!/usr/bin/env node
// The local input socket: a real pipe (or unix socket), the real framing, and the real router seam.
//
// WHAT IT MUST PROVE, and why each is here rather than assumed:
//   - a frame reaches the SAME `handleRequest` the HTTP server uses, so a route cannot behave
//     differently depending on how it was reached;
//   - bytes written in order arrive in order, which is the property that makes the socket worth
//     having at all;
//   - a refusal travels back, so an operator typing into a process that has gone is told;
//   - a client that cannot connect answers null, because on WSL, against another host, or against an
//     older daemon there is nothing to connect to and the caller must use HTTP;
//   - a socket that dies mid-session reports it, so the next keystroke can go by HTTP.
//
// IT USES A REAL SOCKET, not a double. The whole point of this module is what the operating system
// does with a pipe, and a fake stream would prove the test harness instead.

import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FrameReader, InputSocketServer, connectInputSocket, encodeFrame, localSocketAddress, requestFromFrame }
  from "../lib/input-socket.mjs";

let seq = 0;
const addressFor = () => localSocketAddress({ port: `test-${process.pid}-${++seq}`, dir: os.tmpdir() });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A router that records what it was asked, and refuses one known id. */
function recordingRouter() {
  const seen = [];
  return {
    seen,
    async handle(request, deps) {
      seen.push({ path: request.path, method: request.method, data: request.body?.data, deps });
      if (request.path.includes("/gone/")) return { status: 404, body: { error: "no such process" } };
      return { status: 204, body: null };
    },
  };
}

test("an address is a pipe on Windows and a socket file elsewhere", () => {
  const win = localSocketAddress({ platform: "win32", port: 8802 });
  assert.ok(win.startsWith(String.fromCharCode(92, 92, 46, 92)), win);
  assert.ok(win.endsWith("aify-env-8802"), win);
  const posix = localSocketAddress({ platform: "linux", port: 8802, dir: "/run/user/1000" });
  assert.equal(posix, path.join("/run/user/1000", "aify-env-8802.sock"));
  // Two daemons on one host must not share an address, which is why the port is in the name.
  assert.notEqual(localSocketAddress({ platform: "win32", port: 1 }), localSocketAddress({ platform: "win32", port: 2 }));
});

test("frames are split on newlines, and a malformed one is skipped rather than fatal", () => {
  const reader = new FrameReader();
  assert.deepEqual(reader.push(Buffer.from('{"a":1}\n{"b":')), [{ a: 1 }]);
  assert.deepEqual(reader.push(Buffer.from('2}\nnot json\n{"c":3}\n')), [{ b: 2 }, { c: 3 }]);
});

test("a sender that never ends a frame cannot grow the buffer without limit", () => {
  const reader = new FrameReader({ maxBytes: 64 });
  reader.push(Buffer.from("x".repeat(200)));
  assert.equal(reader.overflowed, true);
  // And it recovers: the next complete frame is still read.
  assert.deepEqual(reader.push(Buffer.from('{"ok":true}\n')), [{ ok: true }]);
});

test("a frame without a usable path is not turned into a request", () => {
  for (const frame of [null, "string", {}, { path: "" }, { path: "processes/x/input" }, { path: 7 }]) {
    assert.equal(requestFromFrame(frame), null, JSON.stringify(frame));
  }
  assert.deepEqual(requestFromFrame({ path: "/processes/x/input", body: { data: "a" } }),
    { method: "POST", path: "/processes/x/input", body: { data: "a" } });
});

test("keystrokes reach the router in order, through one socket", async () => {
  const router = recordingRouter();
  const server = await new InputSocketServer({ address: addressFor(), handleRequest: router.handle, deps: { tag: "deps" } }).start();
  const client = await connectInputSocket({ address: server.address });
  assert.ok(client, "the client must connect to a socket that is listening");
  for (const key of "hello") client.send("/processes/a1/input", { data: key });
  await settle();
  assert.equal(router.seen.map((r) => r.data).join(""), "hello");
  assert.equal(router.seen[0].path, "/processes/a1/input");
  assert.equal(router.seen[0].method, "POST", "a frame defaults to the method its route expects");
  client.close();
  await server.stop();
});

test("the deps builder is called per frame, as the HTTP server calls it per request", async () => {
  // Plugins start after the server binds, so deps captured once would be stale for the life of the
  // process. This is the seam where that would silently happen.
  let calls = 0;
  const router = recordingRouter();
  const server = await new InputSocketServer({
    address: addressFor(), handleRequest: router.handle, deps: async () => ({ call: ++calls }),
  }).start();
  const client = await connectInputSocket({ address: server.address });
  client.send("/processes/a1/input", { data: "x" });
  client.send("/processes/a1/input", { data: "y" });
  await settle();
  assert.deepEqual(router.seen.map((r) => r.deps.call), [1, 2]);
  client.close();
  await server.stop();
});

test("a refusal travels back, so typing into a process that has gone is not silent", async () => {
  const router = recordingRouter();
  const server = await new InputSocketServer({ address: addressFor(), handleRequest: router.handle, deps: {} }).start();
  const refusals = [];
  const client = await connectInputSocket({ address: server.address, onRefusal: (frame) => refusals.push(frame) });
  client.send("/processes/gone/input", { data: "a" });
  await settle();
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].status, 404);
  client.close();
  await server.stop();
});

test("a keystroke that landed gets no answer at all", async () => {
  // Waiting for one would put the round trip back into the path this exists to shorten.
  const router = recordingRouter();
  const server = await new InputSocketServer({ address: addressFor(), handleRequest: router.handle, deps: {} }).start();
  const replies = [];
  const client = await connectInputSocket({ address: server.address, onRefusal: (frame) => replies.push(frame) });
  for (let i = 0; i < 5; i++) client.send("/processes/a1/input", { data: "k" });
  await settle();
  assert.deepEqual(replies, []);
  client.close();
  await server.stop();
});

test("connecting to an address nobody is listening on answers null, not an error", async () => {
  // This is the WSL case, the other-machine case and the older-daemon case, and each must fall back
  // to HTTP rather than end the attach.
  assert.equal(await connectInputSocket({ address: addressFor(), timeoutMs: 200 }), null);
  assert.equal(await connectInputSocket({ address: "" }), null);
  assert.equal(await connectInputSocket({}), null);
});

test("a socket that dies mid-session says so, and refuses further sends", async () => {
  const router = recordingRouter();
  const server = await new InputSocketServer({ address: addressFor(), handleRequest: router.handle, deps: {} }).start();
  let closed = false;
  const client = await connectInputSocket({ address: server.address, onClose: () => { closed = true; } });
  assert.equal(client.send("/processes/a1/input", { data: "a" }), true);
  await server.stop();
  await settle();
  assert.equal(closed, true, "the client must learn that the daemon went away");
  assert.equal(client.send("/processes/a1/input", { data: "b" }), false,
    "a send that returns false is what makes the caller fall back to HTTP");
});

test("the server survives a client that sends rubbish", async () => {
  const router = recordingRouter();
  const server = await new InputSocketServer({ address: addressFor(), handleRequest: router.handle, deps: {} }).start();
  const raw = net.connect(server.address);
  await new Promise((resolve) => raw.once("connect", resolve));
  raw.write("this is not a frame\n");
  raw.write(encodeFrame({ path: "not-absolute" }));
  raw.write(encodeFrame({ path: "/processes/a1/input", body: { data: "survived" } }));
  await settle();
  assert.deepEqual(router.seen.map((r) => r.data), ["survived"]);
  raw.end();
  await server.stop();
});

test("stopping the server does not wait for an attached client", async () => {
  // WHAT THIS DOES AND DOES NOT PROVE, measured 2026-09-20 rather than assumed. `net.Server.close()`
  // is documented to stop accepting and then wait for live connections to end, which would make a
  // daemon shutting down with a pane attached wait for the operator to close that pane. The server
  // destroys open sockets first for that reason.
  //
  // ON WINDOWS NAMED PIPES IT CANNOT FAIL: removing the destroy and running this test alone still
  // passes, so on this host it is a regression guard for POSIX, where the documented wait applies,
  // and not evidence about Windows. It is kept because aify-env runs on Linux and macOS too.
  //
  // AND IT IS NOT THE CAUSE OF THE TEN-MINUTE HANG that prompted it: that run was a mutation sweep,
  // the same mutant finished in seconds afterwards, and the cause is UNEXPLAINED. Recorded as
  // unexplained rather than attached to this fix.
  const router = recordingRouter();
  const server = await new InputSocketServer({ address: addressFor(), handleRequest: router.handle, deps: {} }).start();
  const client = await connectInputSocket({ address: server.address });
  assert.ok(client.live, "the client is attached, which is the case that used to hang");
  const stopped = await Promise.race([
    server.stop().then(() => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(stopped, "stopped");
});
