#!/usr/bin/env node
// The whole seam, end to end: a key written to the local socket comes out of a real process's stdin.
//
// WHY THIS EXISTS BESIDE THE UNIT TESTS. Those prove the framing, the router seam and the fallback
// by calling them. None of them proves that the socket is wired to the SAME runner the HTTP route
// writes to -- and a green helper suite hiding a disconnected call site is this project's most
// repeated failure. Here the bytes leave a socket and arrive in a child process, or the test fails.
//
// THE CONTROL IS IN THE SAME RUN: the identical frame sent to a process id that does not exist must
// come back refused. Without it, a test that "sent a key and saw output" would pass against a socket
// that echoed its own input.

import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";

import { InputSocketServer, connectInputSocket, localSocketAddress } from "../lib/input-socket.mjs";
import { Runner } from "../lib/runner.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

/** A process that echoes whatever is typed at it, prefixed, and stays up. */
const echoes = () => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", "process.stdin.on('data', (d) => process.stdout.write('got:' + d)); setTimeout(() => {}, 5000)"],
});

const until = async (predicate, ms = 4000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

test("a key sent over the local socket arrives in the process's stdin", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(echoes());
  const seen = [];
  handle.onOutput((chunk) => seen.push(chunk));

  const server = await new InputSocketServer({
    address: localSocketAddress({ port: `e2e-${process.pid}`, dir: os.tmpdir() }),
    handleRequest,
    deps: () => ({ runner }),
  }).start();
  const refusals = [];
  const client = await connectInputSocket({ address: server.address, onRefusal: (frame) => refusals.push(frame) });

  try {
    assert.ok(client, "the client must connect");
    client.send(`/processes/${encodeURIComponent(handle.id)}/input`, { data: `typed${String.fromCharCode(10)}` });
    const arrived = await until(() => seen.join("").includes("got:typed"));
    assert.ok(arrived, `the process never received it; it printed: ${JSON.stringify(seen.join(""))}`);
    assert.deepEqual(refusals, [], "a key that landed must not be answered");

    // CONTROL, same socket, same frame shape: an id nothing is running must be refused, so the
    // assertion above cannot be satisfied by a socket that merely accepted bytes.
    client.send("/processes/no-such-process/input", { data: "x" });
    const refused = await until(() => refusals.length > 0);
    assert.ok(refused, "an unknown process must be refused, or this test proves only that bytes were accepted");
    assert.equal(refusals[0].status, 404);
  } finally {
    client?.close();
    await server.stop();
    try { await runner.stop(handle.id); } catch { /* it may already be gone */ }
  }
});
