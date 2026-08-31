// The key this daemon presents to one service, from the environment or the store.
//
// THIS IS THE JOIN, and it is where the carrier stops being a diagnostic and starts delivering. The
// pieces below it are each proven on their own; what these assert is that a key written by
// `credential set` is the key a beat actually carries, and that every way of failing produces a
// TYPED answer rather than an empty string that reads like "this service needs no credential".

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { credentialForTarget, credentialReadinessFor } from "../lib/credential-resolve.mjs";
import { writeCredentialFile } from "../lib/credential-fs.mjs";
import {
  CREDENTIAL_ABSENT,
  CREDENTIAL_CONFLICT,
  CREDENTIAL_INSECURE,
  CREDENTIAL_MISSING,
  CREDENTIAL_OK,
} from "../lib/credential-store.mjs";

const FILE_KEY = "file-key-1234567890abcdef";
const ENV_KEY = "env-key-0987654321fedcba";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-credres-"));
}

const target = (over = {}) => ({
  name: "aify-comms",
  url: "http://127.0.0.1:8800/api/v1/environments/heartbeat",
  keyEnv: ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"],
  credentialRef: "svc.key",
  ...over,
});

test("a key written to the store is the key a beat would carry", async () => {
  // THE WHOLE POINT. Everything else in this carrier is scaffolding around this one sentence.
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "svc.key", value: FILE_KEY });
    const answer = await credentialForTarget(target(), { root, env: {} });
    assert.equal(answer.state, CREDENTIAL_OK, answer.detail);
    assert.equal(answer.value, FILE_KEY);
    assert.equal(answer.source, "file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the environment overrides the store, because exporting a key is a choice", async () => {
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "svc.key", value: FILE_KEY });
    const answer = await credentialForTarget(target(), { root, env: { AIFY_API_KEY: FILE_KEY } });
    assert.equal(answer.source, "env", "the file silently overruled a manual launch override");
    assert.equal(answer.value, FILE_KEY);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("environment and store DISAGREEING sends no key at all", async () => {
  // The shape where clients hold one key and the service runs on another: every call 401s with both
  // halves looking correctly configured. Presenting either one would be picking a side silently.
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "svc.key", value: FILE_KEY });
    const answer = await credentialForTarget(target(), { root, env: { AIFY_API_KEY: ENV_KEY } });
    assert.equal(answer.state, CREDENTIAL_CONFLICT);
    assert.equal(answer.value, "", "a conflict still handed over a key to present");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("A BROKEN STORE WINS OVER AN ENVIRONMENT KEY, so the fault cannot hide", async () => {
  // The registry says this service HAS a stored credential. If it cannot be read, the operator has a
  // broken store and needs to hear so. Falling back to an environment value would hide exactly the
  // condition the typed states exist to surface -- and on a host where the two differ it would also
  // mean presenting a key nobody expected.
  const root = scratch();
  try {
    const answer = await credentialForTarget(
      target({ credentialRef: "gone.key" }), { root, env: { AIFY_API_KEY: ENV_KEY } });
    assert.equal(answer.state, CREDENTIAL_MISSING);
    assert.equal(answer.value, "", "it fell back to the environment and hid a broken store");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("NO reference is not a fault -- a keyless service is a valid deployment", async () => {
  const root = scratch();
  try {
    const none = await credentialForTarget(target({ credentialRef: "" }), { root, env: {} });
    assert.equal(none.state, CREDENTIAL_ABSENT);
    // And with only an environment key it still resolves, which is the pre-carrier behaviour that
    // must keep working for anyone launching the daemon by hand.
    const fromEnv = await credentialForTarget(
      target({ credentialRef: "" }), { root, env: { CLAUDE_MCP_API_KEY: ENV_KEY } });
    assert.equal(fromEnv.value, ENV_KEY);
    assert.equal(fromEnv.source, "env");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the first NAME the registry declares wins, in the order it declares them", async () => {
  const root = scratch();
  try {
    const answer = await credentialForTarget(target({ credentialRef: "" }), {
      root, env: { CLAUDE_MCP_API_KEY: "first", AIFY_API_KEY: "second" },
    });
    assert.equal(answer.value, "first");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("readiness reports names, states and a boolean -- and NEVER the key", async () => {
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "svc.key", value: FILE_KEY });
    const readiness = await credentialReadinessFor([target()], { root, env: {} });
    const entry = readiness["aify-comms"];
    assert.equal(entry.hasCredential, true);
    assert.equal(entry.state, CREDENTIAL_OK);
    assert.equal(entry.credentialRef, "svc.key");
    assert.deepEqual(entry.keyEnv, ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"]);
    // `/health` is unauthenticated. A value, a length, a prefix or a hash each narrow a search that
    // the boolean does not.
    assert.ok(!JSON.stringify(readiness).includes(FILE_KEY), "the key reached the health report");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("readiness explains a FAULT and stays quiet on a plain absence", async () => {
  // A reader must not mistake an explanation for a problem: "no credential configured" is what a
  // keyless service looks like, and dressing it in a detail string makes every one of them look broken.
  const root = scratch();
  try {
    const faulted = await credentialReadinessFor([target({ credentialRef: "gone.key" })], { root, env: {} });
    assert.equal(faulted["aify-comms"].state, CREDENTIAL_MISSING);
    assert.notEqual(faulted["aify-comms"].detail, "");
    // AND IT MUST NOT CLAIM A CREDENTIAL. A mutation hard-coding this to true survived until this
    // line existed: every other assertion here is about the happy path, where true is correct.
    assert.equal(faulted["aify-comms"].hasCredential, false,
                 "a broken store reported as holding a credential");

    const absent = await credentialReadinessFor([target({ credentialRef: "" })], { root, env: {} });
    assert.equal(absent["aify-comms"].state, CREDENTIAL_ABSENT);
    assert.equal(absent["aify-comms"].detail, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("an INSECURE file is a fault, not a key", async () => {
  // On Windows a file written the ordinary way inherits a group grant; anyone in that group holds
  // the key. Reading it anyway would make the custody check decorative.
  const root = scratch();
  try {
    fs.writeFileSync(path.join(root, "svc.key"), `${FILE_KEY}\n`);
    const answer = await credentialForTarget(target(), { root, env: {} });
    if (process.platform === "win32") {
      assert.equal(answer.state, CREDENTIAL_INSECURE, answer.detail);
      assert.equal(answer.value, "");
    } else {
      // On POSIX the scratch file is 0644 by default, which is equally refused.
      assert.notEqual(answer.state, CREDENTIAL_OK);
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ok */ }
  }
});

test("A ROTATED KEY IS PICKED UP ON THE VERY NEXT READ", async () => {
  // There WAS a cache here and the reviewer showed it was pure downside: it called the reader first
  // -- which already reads every byte -- and only then compared a device/inode/size/mtime tuple to
  // decide whether to return the PREVIOUS object instead of the fresh one it had just fetched. It
  // saved no work and added a way to serve a stale key, because that tuple is metadata rather than
  // content: an inode can be zero or reused, and a same-size atomic replacement can share an mtime
  // tick. Rotation is the one moment the key is guaranteed to have changed, so it is the one moment
  // a stale answer is worst.
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "svc.key", value: FILE_KEY });
    assert.equal((await credentialForTarget(target(), { root, env: {} })).value, FILE_KEY);

    // SAME LENGTH as the original, so a size comparison cannot tell them apart -- which is what the
    // removed cache would have keyed on.
    const rotated = "file-key-abcdef0987654321";
    assert.equal(rotated.length, FILE_KEY.length, "the fixture stopped testing what it says it does");
    await writeCredentialFile({ root, ref: "svc.key", value: rotated });
    assert.equal((await credentialForTarget(target(), { root, env: {} })).value, rotated,
                 "a rotated key was not picked up");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
