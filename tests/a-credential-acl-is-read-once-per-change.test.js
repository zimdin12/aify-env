#!/usr/bin/env node
// The daemon asks icacls for a credential file's ACL once per change of the file, not once per read.
//
// THE BUG THIS CATCHES. Every plugin call and every HTTP request read the key, and every read spawned
// icacls. Profiled on the operator's daemon 2026-09-28: 80% of the main thread's wall time was that
// spawn, and every keystroke echo in every herdr-aify pane waited behind it.
//
// WHAT MUST NOT BE LOST WITH IT, each held below against the real store and the real icacls:
//   - a rotated key is presented at once (the key's bytes are never cached);
//   - an ACL widened after a good read refuses the very next read (ctime moves on an ACL change,
//     measured on this host).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ACL_CACHE_MS, CredentialAclCache } from "../lib/credential-acl-cache.mjs";
import { readAcl, readCredentialFile, writeCredentialFile } from "../lib/credential-fs.mjs";
import { CREDENTIAL_INSECURE, CREDENTIAL_OK } from "../lib/credential-store.mjs";

const stats = (over = {}) => ({ dev: 1, ino: 100, ctimeMs: 5000, ...over });

/** A cache over a reader that counts its calls and answers `answers` in turn (the last one repeats). */
function counted(answers = ["ACL"], options = {}) {
  let calls = 0;
  const cache = new CredentialAclCache({
    read: async () => { const answer = answers[Math.min(calls, answers.length - 1)]; calls += 1; if (answer instanceof Error) throw answer; return answer; },
    ...options,
  });
  return { cache, calls: () => calls };
}

test("an unchanged file is asked about once", async () => {
  const { cache, calls } = counted();
  for (let i = 0; i < 5; i += 1) assert.equal(await cache.read("k", stats()), "ACL");
  assert.equal(calls(), 1);
});

test("a moved ctime (an ACL change) or a moved inode (a replacement) asks again", async () => {
  const { cache, calls } = counted(["first", "second", "third"]);
  assert.equal(await cache.read("k", stats()), "first");
  assert.equal(await cache.read("k", stats({ ctimeMs: 5001 })), "second");
  assert.equal(await cache.read("k", stats({ ctimeMs: 5001, ino: 101 })), "third");
  assert.equal(calls(), 3);
});

test("an answer older than the TTL is asked again even for an unchanged file", async () => {
  let clock = 0;
  const { cache, calls } = counted(["first", "second"], { now: () => clock });
  await cache.read("k", stats());
  clock = ACL_CACHE_MS - 1;
  assert.equal(await cache.read("k", stats()), "first");
  clock = ACL_CACHE_MS;
  assert.equal(await cache.read("k", stats()), "second");
  assert.equal(calls(), 2);
});

test("a clock that goes BACKWARDS expires the answer instead of stretching it (review 2026-09-29)", async () => {
  // The reviewer's probe: ttl 100, read at 10000, the ACL changes where ctime cannot show it, the clock
  // is set back to 0. A negative age read as fresh kept serving "private" for ever.
  let clock = 10_000;
  const { cache, calls } = counted(["private", "world-readable"], { ttlMs: 100, now: () => clock });
  assert.equal(await cache.read("k", stats()), "private");
  clock = 0;
  assert.equal(await cache.read("k", stats()), "world-readable");
  assert.equal(calls(), 2);
});

test("the default clock is monotonic: a wall clock jumping ahead does not expire a fresh answer", async (t) => {
  // Distinguishes the clock SOURCE: with Date.now as the default this jump re-asks at once. Date.now
  // is replaced BEFORE the cache exists, because a default captures the function it was given.
  const realNow = Date.now;
  let jump = 0;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + jump;
  const { cache, calls } = counted(["first", "second"]);
  assert.equal(await cache.read("k", stats()), "first");
  jump = 10 * ACL_CACHE_MS;
  assert.equal(await cache.read("k", stats()), "first");
  assert.equal(calls(), 1);
});

test("a failed read is not kept: empty, or a reader that throws, is asked again next time", async () => {
  const { cache, calls } = counted(["", new Error("icacls went away"), "ACL"]);
  assert.equal(await cache.read("k", stats()), "");
  assert.equal(await cache.read("k", stats()), "", "a throwing reader answers empty, which refuses the key");
  assert.equal(await cache.read("k", stats()), "ACL");
  assert.equal(calls(), 3);
});

test("concurrent reads of a cold file share one icacls", async () => {
  const { cache, calls } = counted();
  const answers = await Promise.all([1, 2, 3, 4].map(() => cache.read("k", stats())));
  assert.deepEqual(answers, ["ACL", "ACL", "ACL", "ACL"]);
  assert.equal(calls(), 1);
});

test("two files are two entries", async () => {
  const { cache, calls } = counted();
  await cache.read("a", stats());
  await cache.read("b", stats());
  assert.equal(calls(), 2);
});

// ── the real store and the real icacls ───────────────────────────────────────────────────────
const onWindows = { skip: process.platform === "win32" ? false : "the ACL is read only on Windows" };

async function withStore(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-acl-cache-"));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked-down leftovers */ } });
  let icacls = 0;
  const acl = new CredentialAclCache({ read: (target) => { icacls += 1; return readAcl(target); } });
  await fn({ root, acl, icacls: () => icacls });
}

test("through the store: one icacls for repeated reads, and a rotated key is presented at once", onWindows, async (t) => {
  await withStore(t, async ({ root, acl, icacls }) => {
    assert.ok((await writeCredentialFile({ root, ref: "svc.key", value: "first-key-0123456789abcdef" })).ok);
    for (let i = 0; i < 4; i += 1) {
      const read = await readCredentialFile({ root, ref: "svc.key", acl });
      assert.equal(read.state, CREDENTIAL_OK, read.detail);
      assert.equal(read.value, "first-key-0123456789abcdef");
    }
    assert.equal(icacls(), 1, "four reads of an unchanged file each asked icacls");

    assert.ok((await writeCredentialFile({ root, ref: "svc.key", value: "second-key-0123456789abcdef" })).ok);
    const rotated = await readCredentialFile({ root, ref: "svc.key", acl });
    assert.equal(rotated.state, CREDENTIAL_OK, rotated.detail);
    assert.equal(rotated.value, "second-key-0123456789abcdef", "the old key was presented after rotation");
  });
});

test("through the store: an ACL widened after a good read refuses the very next read", onWindows, async (t) => {
  await withStore(t, async ({ root, acl }) => {
    assert.ok((await writeCredentialFile({ root, ref: "svc.key", value: "a-key-0123456789abcdef" })).ok);
    const before = await readCredentialFile({ root, ref: "svc.key", acl });
    assert.equal(before.state, CREDENTIAL_OK, `CONTROL: the stored key must read first: ${before.detail}`);

    execFileSync("icacls", [path.join(root, "svc.key"), "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
    const after = await readCredentialFile({ root, ref: "svc.key", acl });
    assert.equal(after.state, CREDENTIAL_INSECURE, "a key everyone can read was still handed back");
    assert.equal(after.value, "");
  });
});

// ── the daemon reads through the cache ───────────────────────────────────────────────────────
// bin/aify-env.mjs cannot be imported (it starts a daemon), so its calls are read from source. EVERY
// credential read there runs per request or per plugin call, so every one must carry the cache.
test("every credential read in the daemon carries the cached reading options", () => {
  const source = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const calls = [...source.matchAll(/\b(credentialForTarget|credentialReadinessFor|readCredentialFile)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)];
  assert.ok(calls.length >= 3, `CONTROL: expected the daemon's three credential reads, found ${calls.length}`);
  for (const [whole, , args] of calls) {
    assert.match(args, /,\s*credentialReading\(\)\s*$/, `reads without the ACL cache: ${whole}`);
  }
  assert.match(source, /acl: CREDENTIAL_ACL/, "credentialReading() no longer hands over the cache");
});
