// A real default-socket boot must preserve socket birth privacy without lending its umask to the publisher.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { sealedHomeEnv } from "./_sealed-daemon-env.mjs";

const entry = path.resolve(import.meta.dirname, "../bin/aify-env.mjs");
const observer = pathToFileURL(path.join(import.meta.dirname, "helpers/socket-birth-observer.mjs")).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("default socket startup leaves definitions searchable and the socket born private",
  { skip: process.platform === "win32" }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
    const directory = path.join(root, ".aify/agent-definitions");
    const record = path.join(root, "socket-birth.jsonl");
    const bodies = [];
    const receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/agent-state") { res.writeHead(404).end(); return; }
        bodies.push(JSON.parse(body));
        res.writeHead(204).end();
      });
    });
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const registry = path.join(root, ".aify/services.json");
    fs.mkdirSync(path.dirname(registry));
    fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "socket-startup-fixture": {
      endpoint: `http://127.0.0.1:${receiver.address().port}`, agentState: { path: "/agent-state" },
    } } }));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|USERNAME|USERDOMAIN)$/i.test(name)));
    const env = sealedHomeEnv({ ...inherited, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      TEMP: root, TMP: root, TMPDIR: root, XDG_RUNTIME_DIR: root,
      AIFY_ADVERTISE: "0", AIFY_NO_DASHBOARD: "1",
      AIFY_SERVICE_REGISTRY: registry, AIFY_ENV_PROCESS_RECORD: path.join(root, "processes.json"),
      SOCKET_BIRTH_RECORD: record });
    assert.equal(env.HOME, root, "the standard home seal must admit this private fixture");
    assert.equal(fs.existsSync(directory), false, "the fixture must not precreate the victim directory");
    const child = spawn(process.execPath, ["--import", observer, entry, "--port", "0"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 10000); });
      const orderly = await Promise.race([closed.then(() => true), deadline]);
      clearTimeout(timer);
      await closed;
      await new Promise((resolve) => receiver.close(resolve));
      // Only the owned failed fixture: permit deletion after the assertion has observed the real mode.
      if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(orderly, true, "daemon cleanup required forced termination");
      assert.equal(child.exitCode, 0, output);
    });
    let address;
    for (const end = Date.now() + 20000; Date.now() < end; await pause(10)) {
      address = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (address || child.exitCode !== null || child.signalCode !== null) break;
    }
    assert.ok(address, output);
    // Observe before HTTP or a diagnostic store access: neither probe can manufacture the bad directory.
    const stat = fs.lstatSync(directory);
    const born = fs.readFileSync(record, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(born.length, 1, "one actual UNIX-socket bind must have been observed");
    assert.equal(born[0].socket, true, JSON.stringify(born));
    assert.equal(born[0].mode, 0o600, "socket birth must be private before any later chmod");
    assert.equal((stat.mode & 0o100) !== 0, true, "fresh startup must leave its definition directory searchable");
    await new DefinitionStore({ dir: directory }).list();
    assert.equal((await fetch(address + "/health")).status, 200);
    for (const end = Date.now() + 5000; Date.now() < end && !bodies.length; await pause(10)) {}
    assert.ok(bodies.length > 0, "the real publisher must reach the local receiver");
    assert.equal(bodies[0].complete, true, "publication must come from a complete real store observation");
  });
