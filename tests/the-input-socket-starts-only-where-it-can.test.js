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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startInputSocket, SOCKET_MODE } from "../lib/input-socket-start.mjs";
import { askIncumbent } from "../lib/incumbent.mjs";
import { MAX_FRAME_BYTES, socketDirectory } from "../lib/input-socket.mjs";
import { hostConfigPath, readHostConfig } from "../lib/host-config.mjs";

/** A server double that records how it was built, whether it started, and whether it was stopped. */
function fakeServer({ failOn } = {}) {
  const built = [];
  const stopped = [];
  const create = (options) => {
    built.push(options);
    return {
      address: options.address,
      async start() {
        if (failOn) throw new Error(failOn);
        return { address: options.address, started: true, async stop() { stopped.push(options.address); } };
      },
    };
  };
  return { built, stopped, create };
}

/** The filesystem the POSIX branch talks to, answering whatever mode the test needs it to. */
function fakeFs({ dirMode = 0o700, socketMode = SOCKET_MODE, chmodFails = false,
  dirUid = typeof process.getuid === "function" ? process.getuid() : 0 } = {}) {
  const calls = { mkdir: [], chmod: [], unlink: [], umask: [] };
  return {
    calls,
    mkdir: (p, options) => calls.mkdir.push([p, options?.mode]),
    unlink: (p) => calls.unlink.push(p),
    chmod: (p, mode) => { calls.chmod.push([p, mode]); if (chmodFails) throw new Error("EPERM"); },
    stat: (p) => ({ mode: p.endsWith(".sock") ? socketMode : dirMode, uid: dirUid, isSymbolicLink: () => false }),
    umask: (mode) => { calls.umask.push(mode); return 0o022; },
  };
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
  assert.equal(chmodded, 0, "a pipe has no file mode to change");
});

test("a Windows pipe name cannot be guessed, because nothing else about it is private", async () => {
  // EXTERNAL REVIEW, 2026-09-21, finding D. The comment here USED TO SAY a pipe "inherits the
  // creating token's default DACL, which already excludes other users". MEASURED on this host with
  // GetSecurityInfo against a real pipe this module opened, and it is FALSE:
  //   O:LA G:.. D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)(A;;FR;;;WD)(A;;FR;;;AN)
  // `WD` is Everyone and `AN` is ANONYMOUS LOGON, each with FILE_GENERIC_READ (0x120089). So other
  // accounts CAN open it. What they cannot do is write to it -- FILE_WRITE_DATA is absent, so it is
  // not a keystroke injection channel -- nor add an instance, which needs FILE_CREATE_PIPE_INSTANCE.
  //
  // WHAT IS LEFT is squatting: create the name BEFORE the daemon and answer the attach client in its
  // place. Node exposes neither FILE_FLAG_FIRST_PIPE_INSTANCE nor a descriptor, so an unguessable
  // name is the whole mitigation. POSIX gets this from its 0700 directory instead.
  const server = fakeServer();
  const first = await startInputSocket({
    enabled: true, port: 8802, platform: "win32", handleRequest: () => {}, deps: {}, createServer: server.create,
  });
  const second = await startInputSocket({
    enabled: true, port: 8802, platform: "win32", handleRequest: () => {}, deps: {}, createServer: server.create,
  });
  assert.notEqual(first.address, second.address, "the same port twice must not give the same name twice");
  assert.match(first.address, /aify-env-8802-[0-9a-f]{16}$/, first.address);
});

test("on POSIX it clears a stale socket file first and locks the new one to this user", async () => {
  const server = fakeServer();
  const fs = fakeFs();
  const result = await startInputSocket({
    enabled: true, port: 8802, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/run/user/1000/aify-env",
    createServer: server.create, ...fs,
  });
  assert.ok(result.address.endsWith(".sock"), result.address);
  assert.deepEqual(fs.calls.unlink, [result.address], "a socket file left by a dead daemon refuses the bind");
  assert.deepEqual(fs.calls.chmod, [[result.address, 0o600]],
    "a socket anyone can open is a keystroke injection channel into an agent's terminal");
});

test("the socket is BORN locked, not locked a moment after it is born", async () => {
  // EXTERNAL REVIEW, 2026-09-21, finding D. The bind came first and the chmod after it, which is a
  // window in which the socket carries the umask's mode and anyone on the machine can connect.
  // MEASURED UNDER WSL against this module: mode 755 at bind, 600 after -- and 600 at bind once the
  // umask is narrowed around it. That run is the evidence; this test holds the mechanism, because
  // Windows cannot create a unix socket to observe a mode on.
  const server = fakeServer();
  const fs = fakeFs();
  await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/run/user/1000/aify-env",
    createServer: server.create, ...fs,
  });
  assert.deepEqual(fs.calls.umask, [0o177, 0o022],
    "narrowed before the bind and restored after it: a process-wide umask left narrow is its own defect");
});

test("a socket that could not be locked is never advertised", async () => {
  // The other half of D: the chmod sat in `try {} catch {}` and its failure was never consulted, so
  // the daemon published a 755 socket on /health with nothing in any log. OBSERVED under WSL.
  const server = fakeServer();
  const lines = [];
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/run/user/1000/aify-env",
    createServer: server.create, ...fakeFs({ chmodFails: true }), log: (line) => lines.push(line),
  });
  assert.equal(result, null, "clients must use HTTP rather than a socket the wrong people can open");
  assert.deepEqual(server.stopped.length, 1, "and the listening socket is closed, not left open unadvertised");
  assert.match(lines.join(" "), /EPERM/);
});

test("the mode is READ BACK, so a chmod that succeeded and did nothing is still caught", async () => {
  const server = fakeServer();
  const lines = [];
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/run/user/1000/aify-env",
    createServer: server.create, ...fakeFs({ socketMode: 0o660 }), log: (line) => lines.push(line),
  });
  assert.equal(result, null);
  assert.match(lines.join(" "), /mode 660, not 600/, "the reason has to name what it found");
});

test("a directory other accounts can write to gets no socket at all", async () => {
  // The predictable-path half: a name in a world-writable directory can be pre-created by anyone,
  // which refuses the bind and demotes every pane to HTTP silently. PROVEN under WSL by loosening
  // the directory to 777 and watching the daemon refuse by name.
  const server = fakeServer();
  const lines = [];
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/tmp",
    createServer: server.create, ...fakeFs({ dirMode: 0o777 }), log: (line) => lines.push(line),
  });
  assert.equal(result, null);
  assert.deepEqual(server.built, [], "nothing is bound before the directory is judged");
  assert.match(lines.join(" "), /open to other accounts/);
});

test("a directory owned by another account gets no socket, even at mode 700", async (t) => {
  // The mode check alone passes a 0700 directory someone else made at our predictable path -- and
  // its owner can then read, replace or impersonate whatever is placed inside it.
  if (typeof process.getuid !== "function") { t.skip("no uids on this platform"); return; }
  const server = fakeServer();
  const lines = [];
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/tmp/aify-env-1000",
    createServer: server.create, ...fakeFs({ dirUid: process.getuid() + 1 }), log: (line) => lines.push(line),
  });
  assert.equal(result, null);
  assert.deepEqual(server.built, [], "nothing is bound before the directory is judged");
  assert.match(lines.join(" "), /belongs to uid/);
});

test("a directory that is a symbolic link gets no socket, even when its target is ours", async (t) => {
  // `stat` judged the link's TARGET. In a shared temp root another account can plant the link, pass
  // the check by aiming it at a private directory of ours, and repoint it once the address is
  // advertised -- so the next attach connects to THEIR socket and types into it.
  if (process.platform === "win32") { t.skip("the unix branch needs real unix symlinks"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-socket-dir-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "ours");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  const link = path.join(root, "aify-env-link");
  fs.symlinkSync(target, link);
  const server = fakeServer();
  const lines = [];
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: link,
    createServer: server.create, log: (line) => lines.push(line),
  });
  assert.equal(result, null);
  assert.deepEqual(server.built, [], "no socket is placed through a link");
  assert.match(lines.join(" "), /symbolic link/);
});

test("the directory is this user's own, never the shared temp root", () => {
  assert.equal(socketDirectory({ platform: "win32" }), "", "a named pipe is not a file and has no directory");
  assert.equal(socketDirectory({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" } }),
    path.join("/run/user/1000", "aify-env"), "the per-user runtime directory is where this belongs");
  // With no XDG_RUNTIME_DIR the temp root is still used, but a per-uid directory inside it carries
  // the same property -- `/tmp` itself is mode 777 on every host this runs on.
  const fallback = socketDirectory({ platform: "linux", env: {}, tmpdir: "/tmp", uid: 1000 });
  assert.equal(fallback, path.join("/tmp", "aify-env-1000"));
  assert.notEqual(fallback, "/tmp", "a socket directly in the temp root is the arrangement this replaced");
  // Two accounts on one host get two directories, which is what makes the name unpredictable to them.
  assert.notEqual(fallback, socketDirectory({ platform: "linux", env: {}, tmpdir: "/tmp", uid: 1001 }));
});

test("a stale file that cannot be removed does not stop the attempt", async () => {
  const server = fakeServer();
  const result = await startInputSocket({
    enabled: true, port: 1, platform: "linux", handleRequest: () => {}, deps: {}, dir: "/run/user/1000/aify-env",
    createServer: server.create, ...fakeFs(), unlink: () => { throw new Error("EPERM"); },
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
