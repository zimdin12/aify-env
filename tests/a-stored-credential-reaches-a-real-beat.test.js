// THE PROOF THE WHOLE CARRIER EXISTS FOR: a key written by `credential set` reaches a real HTTP
// advertisement, sent by a real daemon, with NO key anywhere in that daemon's environment.
//
// Every other test in this repo proves a piece or a join in isolation. This one drives the chain end
// to end, because the failure it replaces was not in any single piece -- each behaved correctly and
// the operator still had a daemon that ran and was never believed.
//
// SCOPED TO A SCRATCH HOME AND AN EPHEMERAL PORT. The operator's registry, credential store, process
// record and running daemon are untouched, which matters because this repo's own history includes a
// test that read the operator's real session id and another that reaped a live fleet.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "e2e-proof-key-8f3a2b1c9d4e5f60";

/** A service that refuses an unkeyed beat and accepts a correctly keyed one. */
function keyedService(received) {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ url: req.url, key: req.headers["x-api-key"] ?? null });
      const ok = req.headers["x-api-key"] === KEY;
      res.writeHead(ok ? 200 : 401);
      res.end("{}");
    });
  });
}

function scratchEnv(home) {
  // Deliberately NOT a spread of `process.env`: in a live wrapper environment this process holds the
  // operator's real key, and inheriting it would let this test pass because a REAL credential was
  // present rather than because the carrier delivered one.
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot ?? "",
    USERNAME: process.env.USERNAME ?? "",
    USERDOMAIN: process.env.USERDOMAIN ?? "",
    HOME: home,
    USERPROFILE: home,
  };
}

async function storeCredential(home) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(REPO, "bin", "aify-env-credential.mjs"), "set", "--service", "aify-comms", "--stdin"],
      { env: scratchEnv(home) },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())),
    );
    child.stdin.end(`${KEY}\n`);
  });
}

/** Run a daemon against a keyed service and return the first beat it managed to send. */
async function firstBeat({ home, registry, received }) {
  const daemon = spawn(process.execPath, [path.join(REPO, "bin", "aify-env.mjs"), "--port", "0"], {
    env: {
      ...scratchEnv(home),
      AIFY_ADVERTISE: "1",
      AIFY_ADVERTISE_MS: "500",
      AIFY_SERVICE_REGISTRY: registry,
      AIFY_ENV_PROCESS_RECORD: path.join(home, "env-processes.json"),
      AIFY_NO_DASHBOARD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  daemon.stdout.on("data", (d) => { output += d; });
  daemon.stderr.on("data", (d) => { output += d; });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && received.length === 0) {
    await new Promise((r) => setTimeout(r, 250));
  }
  daemon.kill();
  await new Promise((r) => setTimeout(r, 300));
  return { beat: received[0] ?? null, output };
}

/** A scratch home with a registry naming a keyed service, and the credential stored (or not). */
async function stage({ store = true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-e2e-"));
  const received = [];
  const service = keyedService(received);
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  const port = service.address().port;

  fs.mkdirSync(path.join(home, ".aify"), { recursive: true });
  const registry = path.join(home, ".aify", "services.json");

  // THE REAL ORDER, and the join `install.sh` depends on: the store DERIVES the reference, the
  // installer captures what the command printed, and the registry records THAT. Writing a name of
  // our own choosing here would test a setup nothing produces.
  const ref = await storeCredential(home);
  assert.ok(ref, "the command named no reference");

  fs.writeFileSync(registry, JSON.stringify({
    version: 1,
    services: {
      "aify-comms": {
        endpoint: `http://127.0.0.1:${port}`,
        endpointEnv: ["CLAUDE_MCP_SERVER_URL", "AIFY_SERVER_URL"],
        keyEnv: ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"],
        mcp: [],
        credentialRef: ref,
      },
    },
  }, null, 2));

  if (!store) fs.rmSync(path.join(home, ".aify", "credentials", ref), { force: true });

  return { home, registry, received, ref, close: () => service.close() };
}

test("a key from the STORE reaches a real beat, with none in the daemon's environment", async () => {
  const staged = await stage({ store: true });
  try {
    const { beat, output } = await firstBeat(staged);
    assert.ok(beat, `no advertisement arrived. daemon said: ${output.slice(0, 400)}`);
    assert.equal(beat.url, "/api/v1/environments/heartbeat");
    assert.equal(beat.key, KEY,
                 `the key did not reach the wire (got ${JSON.stringify(beat.key)}). ` +
                 `daemon said: ${output.slice(0, 400)}`);
  } finally {
    staged.close();
    fs.rmSync(staged.home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("NEGATIVE CONTROL: with the stored file gone, no key reaches the wire", async () => {
  // Without this the test above proves only that a key arrived -- not that it came from the STORE.
  // A daemon that picked one up from anywhere else would look identical.
  const staged = await stage({ store: false });
  try {
    const { beat, output } = await firstBeat(staged);
    assert.ok(beat, `no advertisement arrived at all. daemon said: ${output.slice(0, 400)}`);
    assert.notEqual(beat.key, KEY,
                    "the key arrived with no stored file, so it came from somewhere else and the " +
                    "positive test proves nothing");
  } finally {
    staged.close();
    fs.rmSync(staged.home, { recursive: true, force: true, maxRetries: 3 });
  }
});
