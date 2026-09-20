#!/usr/bin/env node
// Bringing the input socket up: when it is attempted, where it lands, and what happens when it fails.
//
// EVERY PATH HERE MUST LEAVE THE DAEMON SERVING. The socket is an optimisation with an HTTP fallback,
// so "could not listen" is an ordinary outcome that gets logged and returns null -- never a throw
// that takes the daemon down with it. That is the property these tests exist to hold.
//
// The platform is injected rather than detected, so the unix branch is judged on Windows and the
// Windows branch on Linux. A branch that only runs on the machine it was written on is a branch that
// breaks on the other one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { startInputSocket } from "../lib/input-socket-start.mjs";
import { askIncumbent } from "../lib/incumbent.mjs";
import { MAX_FRAME_BYTES } from "../lib/input-socket.mjs";
import { hostConfigPath, readHostConfig } from "../lib/host-config.mjs";

/** A server double that records how it was built and whether it was started. */
function fakeServer({ failOn } = {}) {
  const built = [];
  const create = (options) => {
    built.push(options);
    return {
      address: options.address,
      async start() {
        if (failOn) throw new Error(failOn);
        return { address: options.address, started: true };
      },
    };
  };
  return { built, create };
}

test("switched off, nothing is attempted at all", async () => {
  const server = fakeServer();
  const result = await startInputSocket({ enabled: false, port: 1, handleRequest: () => {}, deps: {}, createServer: server.create });
  assert.equal(result, null);
  assert.deepEqual(server.built, [], "a host that said no must not have a socket opened for it");
});

test("on Windows it opens a named pipe and does not touch the filesystem", async () => {
  const server = fakeServer();
  let unlinked = 0, chmodded = 0;
  const result = await startInputSocket({
    enabled: true, port: 8802, platform: "win32", handleRequest: () => {}, deps: {},
    createServer: server.create, unlink: () => { unlinked += 1; }, chmod: () => { chmodded += 1; },
  });
  assert.ok(result.address.includes("pipe"), result.address);
  assert.equal(unlinked, 0, "a pipe leaves no stale file to remove");
  assert.equal(chmodded, 0, "a pipe has no file mode; its DACL comes from the creating token");
});

test("on POSIX it clears a stale socket file first and locks the new one to this user", async () => {
  const server = fakeServer();
  const unlinked = [], chmodded = [];
  const result = await startInputSocket({
    enabled: true, port: 8802, platform: "linux", handleRequest: () => {}, deps: {},
    createServer: server.create, unlink: (p) => unlinked.push(p), chmod: (p, mode) => chmodded.push([p, mode]),
  });
  assert.ok(result.address.endsWith(".sock"), result.address);
  assert.deepEqual(unlinked, [result.address], "a socket file left by a dead daemon refuses the bind");
  assert.deepEqual(chmodded, [[result.address, 0o600]],
    "a socket anyone can open is a keystroke injection channel into an agent's terminal");
});

test("a stale file that cannot be removed does not stop the attempt", async () => {
  const server = fakeServer();
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {},
    createServer: server.create, unlink: () => { throw new Error("EPERM"); }, chmod: () => {},
  });
  assert.ok(result, "the bind is what decides, not the tidy-up");
});

test("a socket that cannot listen is reported and the daemon carries on", async () => {
  const server = fakeServer({ failOn: "EADDRINUSE" });
  const lines = [];
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "win32", handleRequest: () => {}, deps: {},
    createServer: server.create, log: (line) => lines.push(line),
  });
  assert.equal(result, null, "null is how the caller learns clients must use HTTP");
  assert.match(lines.join(" "), /input socket unavailable/);
  assert.match(lines.join(" "), /EADDRINUSE/, "the reason travels, or nobody can act on it");
});

test("the frame ceiling is a real bound, not a suggestion", () => {
  // A keystroke is a few bytes and a paste is thousands; a megabyte is neither, so the reader drops
  // what is past it rather than buffering whatever a sender chooses to send.
  assert.equal(MAX_FRAME_BYTES, 1_048_576);
});

test("the host config path sits beside the registry, not inside it", () => {
  const p = hostConfigPath("/home/dev");
  assert.match(p.replaceAll(String.fromCharCode(92), "/"), /\/home\/dev\/\.aify\/config\.json$/);
  // Reading a home that holds no file yields the defaults rather than throwing.
  assert.equal(readHostConfig({ home: "/definitely/not/a/home", env: {} }).localSocket, true);
});

test("askIncumbent answers null unless an aify-env identifies itself by what it owns", async () => {
  // THE ANSWER DECIDES WHOSE PROCESS TREE GETS KILLED. `{"status":"healthy"}` plus a pid is the most
  // common health body in existence, so a responder that merely looks healthy must not be adopted.
  const answering = (body, status = 200) => async () => ({ status, json: async () => body });
  assert.equal(await askIncumbent({ host: "h", port: 1, fetchImpl: answering({ status: "healthy", pid: 7 }) }), null);
  assert.equal(await askIncumbent({ host: "h", port: 1, fetchImpl: async () => { throw new Error("refused"); } }), null);
  const real = { status: "healthy", pid: 7, version: "0.6.5", processes: [], terminals: {} };
  assert.deepEqual(await askIncumbent({ host: "h", port: 1, fetchImpl: answering(real) }),
    { pid: 7, version: "0.6.5", processes: [] });
  // An aify-env that sends no pid gives the caller nothing to act on, so it is not an incumbent.
  assert.equal(await askIncumbent({ host: "h", port: 1, fetchImpl: answering({ ...real, pid: undefined }) }), null);
});
