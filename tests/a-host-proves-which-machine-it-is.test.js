// A host proves which machine it is to a service, beyond holding the API key (external review of 0.8.1, HIGH 2).
//
// The service records the first proof a machine presents and refuses that machine's host routes without it,
// so the properties that matter here are: one secret per host that never changes once made, a proof that is
// the same every time for one service and different for another, and a comms plugin that actually sends it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostProof, hostProofFor, readOrCreateHostSecret } from "../lib/host-secret.mjs";
import { CommsApi, HOST_PROOF_HEADER, mintBridgeIdentity } from "../lib/plugins/aify-comms/api.mjs";
import { factoryArguments } from "../lib/plugins/index.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "aify-host-secret-"));

test("the secret is made once and read back unchanged after", () => {
  const file = join(scratch(), "nested", "host-secret");
  const made = readOrCreateHostSecret(file);
  assert.match(made, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(readOrCreateHostSecret(file), made, "a second read is the same secret, not a new one");
});

test("a second writer that loses the race reads the first one's secret", () => {
  const file = join(scratch(), "host-secret");
  const first = readOrCreateHostSecret(file);
  // The loser's path: the file appeared after its read found nothing, so its link fails with EEXIST.
  let reads = 0;
  const racing = {
    readFileSync: (...args) => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return readFileSync(...args);
    },
    mkdirSync: () => {}, writeFileSync, linkSync: () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); },
    rmSync: () => {},
  };
  assert.equal(readOrCreateHostSecret(file, { fsImpl: racing }), first);
});

test("a file that is not one whole secret is refused, never replaced", () => {
  const file = join(scratch(), "host-secret");
  writeFileSync(file, "half-written");
  assert.throws(() => readOrCreateHostSecret(file), /is not a host secret/);
  assert.equal(readFileSync(file, "utf8"), "half-written", "replacing it would change this machine's proof");
});

test("the proof is stable for one service, different for another, and is not the secret", () => {
  const secret = readOrCreateHostSecret(join(scratch(), "host-secret"));
  assert.equal(hostProof(secret, "aify-comms"), hostProof(secret, "aify-comms"));
  assert.notEqual(hostProof(secret, "aify-comms"), hostProof(secret, "aify-dashboard"));
  assert.notEqual(hostProof(secret, "aify-comms"), secret);
  assert.equal(hostProofFor("aify-comms", { file: join(scratch(), "host-secret") }).length, 43);
});

test("the comms plugin sends its proof to its own service, and a proof it cannot read is left off", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } };
  };
  const identity = mintBridgeIdentity({ version: "0.8.2" });
  const proving = new CommsApi({ endpoint: "http://127.0.0.1:8800", credential: async () => "k", identity, fetchImpl, hostProof: () => "PROOF" });
  await proving.heartbeat({});
  assert.equal(calls[0].headers[HOST_PROOF_HEADER], "PROOF");

  const unreadable = new CommsApi({ endpoint: "http://127.0.0.1:8800", credential: async () => "k", identity, fetchImpl,
    hostProof: () => { throw new Error("not a host secret"); } });
  await unreadable.heartbeat({});
  assert.equal(calls[1].headers[HOST_PROOF_HEADER], undefined, "the call still goes; the service names the missing proof");
});

test("the plugin registry hands each plugin the proof for its own service name, read when asked", () => {
  const asked = [];
  const shared = { hostProofFor: (name) => { asked.push(name); return `proof-for-${name}`; } };
  const comms = factoryArguments({ name: "aify-comms", endpoint: "http://127.0.0.1:8800" }, shared);
  const dashboard = factoryArguments({ name: "aify-dashboard", endpoint: "http://127.0.0.1:9900" }, shared);
  assert.deepEqual(asked, [], "nothing is read while the plugins are built");
  assert.equal(comms.hostProof(), "proof-for-aify-comms");
  assert.equal(dashboard.hostProof(), "proof-for-aify-dashboard", "never another service's proof");
  assert.equal(comms.endpoint, "http://127.0.0.1:8800");
});
