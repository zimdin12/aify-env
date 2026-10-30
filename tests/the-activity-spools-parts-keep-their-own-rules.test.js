// The file-activity spool's parts that another of its modules imports, each asked for its own rule.
//
// The activity suites drive these through ActivityConsumer and the plugin, most of them only where the wrapper checkout
// is present (_activity-fixture.mjs). These ask each part directly, with no wrapper, so a part's rule is checked on
// every host and a change to it is caught in the part rather than somewhere downstream.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ActivityOperationLock } from "../lib/plugins/aify-dashboard/activity-operation-lock.mjs";
import { activityDeclared } from "../lib/plugins/aify-dashboard/activity-protocol.mjs";
import { LIMITS, ageReason, continuousClock, fileIdentity, validClock, validPolicy, validWitness } from "../lib/plugins/aify-dashboard/activity-raw.mjs";
import { ActivityRetirement } from "../lib/plugins/aify-dashboard/activity-retirement.mjs";
import { ActivityShipper } from "../lib/plugins/aify-dashboard/activity-shipper.mjs";
import { activityDirectories, activityLaunchEnv, wrapperActivity } from "../lib/plugins/aify-dashboard/activity-source.mjs";
import { ActivityState, readSegment, regularFile } from "../lib/plugins/aify-dashboard/activity-state.mjs";
import { ActivityConsumer } from "../lib/plugins/aify-dashboard/activity-consumer.mjs";
import { FILE_ACTIVITY_PATH } from "../lib/plugins/aify-dashboard/dashboard-api.mjs";

const LIFETIME = "0123abcd-0123-4567-89ab-0123456789ab";
const SOURCE = { agentId: "lead", instanceId: "inst", incarnation: LIFETIME, runtime: "claude" };
const WITNESS = { agentId: "lead", instance: "inst", lifetime: LIFETIME, pid: 42, createdAtUs: 1000 };

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-activity-parts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("activityDeclared: only a spec whose fileActivity is exactly {path: FILE_ACTIVITY_PATH} declares the capability", () => {
  assert.equal(activityDeclared({ fixed: { fileActivity: { path: FILE_ACTIVITY_PATH } } }), true);
  assert.equal(activityDeclared({ fixed: { fileActivity: { path: "/api/v1/other" } } }), false);
  assert.equal(activityDeclared({ fixed: { fileActivity: { path: FILE_ACTIVITY_PATH, extra: 1 } } }), false);
  assert.equal(activityDeclared({}), false);
});

test("validPolicy and validClock: exact keys, whole non-negative numbers, and a policy no wider than LIMITS", () => {
  assert.equal(validPolicy({ ...LIMITS }), true);
  for (const key of Object.keys(LIMITS)) {
    assert.equal(validPolicy({ ...LIMITS, [key]: LIMITS[key] + 1 }), false, `${key} above its limit`);
    assert.equal(validPolicy({ ...LIMITS, [key]: 0 }), false, `${key} of zero`);
  }
  assert.equal(validPolicy({ ...LIMITS, extra: 1 }), false);
  assert.equal(validClock({ wallMs: 0, uptimeMs: 5 }), true);
  assert.equal(validClock({ wallMs: -1, uptimeMs: 5 }), false);
  assert.equal(validClock({ wallMs: 1.5, uptimeMs: 5 }), false);
  assert.equal(validClock({ wallMs: 1, uptimeMs: 5, zone: 0 }), false);
});

test("continuousClock and ageReason: both clocks forward and agreeing within 2s, and age is the larger of the two", () => {
  const at = { wallMs: 10_000, uptimeMs: 5_000 };
  assert.equal(continuousClock(at, { wallMs: 12_000, uptimeMs: 7_000 }), true);
  assert.equal(continuousClock(at, { wallMs: 14_001, uptimeMs: 7_000 }), false, "wall and uptime disagree by over 2s");
  assert.equal(continuousClock(at, { wallMs: 9_000, uptimeMs: 4_000 }), false, "both went back");
  const envelope = { appendedAt: at, policy: { maxAgeMs: 3_000 } };
  assert.equal(ageReason(envelope, { wallMs: 9_000, uptimeMs: 4_000 }, 10_000), "clock");
  assert.equal(ageReason(envelope, { wallMs: 12_000, uptimeMs: 7_000 }, 10_000), null);
  assert.equal(ageReason(envelope, { wallMs: 13_000, uptimeMs: 8_000 }, 10_000), "expired", "the envelope's own limit binds");
  assert.equal(ageReason(envelope, { wallMs: 12_000, uptimeMs: 7_000 }, 2_000), "expired", "the reader's limit binds");
  assert.equal(ageReason(envelope, { wallMs: 13_000, uptimeMs: 7_000 }, 10_000), "expired", "the larger of the two ages counts");
});

test("fileIdentity and validWitness: identity is device, inode and birth; a witness must match its source exactly", () => {
  assert.equal(fileIdentity({ dev: 1, ino: 2, birthtimeMs: 3 }), "1:2:3");
  assert.notEqual(fileIdentity({ dev: 1, ino: 2, birthtimeMs: 3 }), fileIdentity({ dev: 1, ino: 2, birthtimeMs: 4 }));
  assert.equal(validWitness(WITNESS, SOURCE), true);
  assert.equal(validWitness({ ...WITNESS, agentId: "other" }, SOURCE), false);
  assert.equal(validWitness({ ...WITNESS, lifetime: "not-a-uuid" }, { ...SOURCE, incarnation: "not-a-uuid" }), false);
  assert.equal(validWitness({ ...WITNESS, pid: 0 }, SOURCE), false);
  assert.equal(validWitness({ ...WITNESS, extra: 1 }, SOURCE), false);
});

test("regularFile and readSegment: a regular file's stat, absence as null, and exactly the bytes of the stat read", (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "seg.jsonl");
  fs.writeFileSync(file, "abc");
  const stat = regularFile(file);
  assert.equal(stat.size, 3);
  assert.equal(regularFile(path.join(dir, "missing")), null);
  assert.throws(() => regularFile(dir), /unsafe-file/);
  fs.appendFileSync(file, "def");
  assert.equal(readSegment(file, stat).toString(), "abc", "bytes written after the stat were read");
  fs.rmSync(file);
  fs.writeFileSync(file, "abcdef");
  assert.throws(() => readSegment(file, stat), /segment-race/, "another file under the same name was read as the stat'd one");
});

test("ActivityOperationLock: a second holder is refused as busy, never waits, and the rendezvous file is never removed", (t) => {
  const file = path.join(scratch(t), "lock");
  const lock = new ActivityOperationLock(file);
  assert.equal(lock.run(() => "done"), "done");
  assert.throws(() => lock.run(() => new ActivityOperationLock(file).run(() => "inside")), /state-busy/);
  assert.equal(lock.run(() => "again"), "again", "CONTROL: once released it is taken again");
  assert.ok(fs.existsSync(file), "the lock file was removed");
});

test("ActivityRetirement: a witness only from a single, alive, matching identity; ended only when the process is gone", () => {
  const current = { agentId: "lead", instance: "inst", lifetime: LIFETIME, pid: 42, harness: "claude", writtenAtUs: 5000 };
  const agents = (over = {}) => ({ rawIdentity: () => ({ unknown: false, conflict: false, current: { ...current, ...over } }) });
  const probe = (answer) => () => new Map([[42, answer]]);
  const alive = probe({ alive: true, createdAtUs: 1000 });
  assert.deepEqual(new ActivityRetirement({ agents: agents(), probe: alive }).observe(SOURCE), WITNESS);
  assert.equal(new ActivityRetirement({ agents: agents({ lifetime: "ffffffff-0123-4567-89ab-0123456789ab" }), probe: alive }).observe(SOURCE), null);
  assert.equal(new ActivityRetirement({ agents: agents({ harness: "codex" }), probe: alive }).observe(SOURCE), null);
  assert.equal(new ActivityRetirement({ agents: agents({ writtenAtUs: undefined }), probe: alive }).observe(SOURCE), null,
    "a record that does not say when it was written cannot tell its own process's answer from a predecessor's");
  assert.equal(new ActivityRetirement({ agents: { rawIdentity: () => ({ unknown: false, conflict: true, current }) }, probe: alive }).observe(SOURCE), null);
  assert.equal(new ActivityRetirement({ agents: agents(), probe: probe({ alive: false }) }).observe(SOURCE), null);

  const ended = (answer) => new ActivityRetirement({ agents: agents(), probe: probe(answer) }).ended({ witness: WITNESS, source: SOURCE });
  assert.equal(ended({ alive: false }), true);
  assert.equal(ended({ alive: true, createdAtUs: 2000 }), true, "a reused pid is not the witnessed process");
  assert.equal(ended({ alive: true, createdAtUs: 1000 }), false);
  assert.equal(ended({ alive: null, createdAtUs: null }), false, "an unanswered probe is not an end");
  assert.equal(new ActivityRetirement({ agents: agents(), probe: probe({ alive: false }) })
    .ended({ witness: { ...WITNESS, agentId: "other" }, source: SOURCE }), false, "an invalid witness proves nothing");
});

test("activityLaunchEnv: the switch, and each of the grant's bounds only when the grant sets it", () => {
  assert.deepEqual(activityLaunchEnv({}), { AIFY_FILE_ACTIVITY: "1" });
  assert.deepEqual(activityLaunchEnv({ sessionBytes: 1024, maxAgeMs: 60_000 }),
    { AIFY_FILE_ACTIVITY: "1", AIFY_ACTIVITY_SESSION_BYTES: "1024", AIFY_ACTIVITY_MAX_AGE_MS: "60000" });
});

test("wrapperActivity: the policy is the wrapper's reading of the producer's own env, and a wrapper without validators is refused", async (t) => {
  const checkout = scratch(t);
  fs.mkdirSync(path.join(checkout, "lib"));
  const adapter = path.join(checkout, "lib", "file-activity.mjs");
  fs.writeFileSync(adapter, [
    "export const activityConfiguration = (env) => ({ enabled: env.AIFY_FILE_ACTIVITY === '1', sessionBytes: Number(env.AIFY_ACTIVITY_SESSION_BYTES ?? 7) });",
    "export const validActivityRecord = () => true;",
    "export const safeAgentId = () => true;",
  ].join("\n"));
  const admitted = await wrapperActivity({ wrapperCheckout: checkout, sessionBytes: 99 });
  assert.deepEqual(admitted.policy, { sessionBytes: 99 }, "the policy is not what the producer's env would give, or kept `enabled`");
  const bare = path.join(scratch(t), "bare");
  fs.mkdirSync(path.join(bare, "lib"), { recursive: true });
  fs.writeFileSync(path.join(bare, "lib", "file-activity.mjs"), "export const activityConfiguration = () => ({});");
  await assert.rejects(wrapperActivity({ wrapperCheckout: bare }), /wrapper-validator/);
  await assert.rejects(wrapperActivity({ wrapperCheckout: path.join(checkout, "missing") }), /wrapper-checkout/);
});

test("activityDirectories: each admitted agent's activity-v2 folder, sorted; lease files and unsafe names are skipped", (t) => {
  const lease = scratch(t);
  for (const agent of ["zed", "amy", "BAD!"]) fs.mkdirSync(path.join(lease, agent, "activity-v2"), { recursive: true });
  fs.mkdirSync(path.join(lease, "noactivity"));
  fs.writeFileSync(path.join(lease, "bob"), "a lease record");
  const safe = (name) => /^[a-z]+$/.test(name);
  assert.deepEqual(activityDirectories(lease, safe).map((root) => root.agentId), ["amy", "zed"]);
  assert.equal(activityDirectories(lease, safe)[0].directory, path.join(lease, "amy", "activity-v2"));
  assert.deepEqual(activityDirectories(path.join(lease, "missing"), safe), []);
});

test("ActivityShipper: no activity section is inactive and asks nothing; an undeclared service is said once per pass and asked once", async (t) => {
  let asked = 0;
  const api = { serviceSpec: async () => { asked += 1; return {}; }, fileActivity: async () => assert.fail("shipped undeclared") };
  const off = new ActivityShipper({ api, endpoint: "e", agents: null, config: () => ({ config: {} }) });
  await off.pass();
  assert.equal(off.state(), null);
  assert.equal(asked, 0, "an inactive shipper asked the service");
  const dir = scratch(t);
  const on = new ActivityShipper({ api, endpoint: "e", agents: null,
    config: () => ({ config: { activity: { enabled: true, leaseDirectory: dir, wrapperCheckout: dir } } }) });
  await on.pass();
  await on.pass();
  assert.deepEqual(on.state(), { passes: 2, coverage: "unknown", problems: ["file activity: service capability was not declared; coverage unknown"] });
  assert.equal(asked, 1, "the service's declaration is asked once, not every pass");
});

test("THE CHECKPOINT HOLDS SIXTEEN SOURCES by default, and a smaller cap is the only other one a consumer takes", () => {
  // The slot-freeing test runs three incarnations against a cap of two, so the production cap is pinned here, where it is
  // set: the frozen LIMITS, and both the consumer and the checkpoint it opens defaulting to it.
  assert.equal(LIMITS.maxSessions, 16, "the frozen production cap moved");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aify-activity-slots-"));
  try {
    const consumer = new ActivityConsumer({ directory, agentId: "a", endpoint: "http://127.0.0.1:1", validRecord: () => true });
    assert.equal(consumer.slots, LIMITS.maxSessions, "a consumer given no cap does not hold the production one");
    assert.equal(consumer.storage.slots, LIMITS.maxSessions, "the checkpoint it opens holds another cap than the consumer's");
    assert.equal(new ActivityState({ directory, endpoint: "http://127.0.0.1:1" }).slots, LIMITS.maxSessions,
      "a checkpoint opened with no cap does not hold the production one");
    for (const slots of [0, 2.5, LIMITS.maxSessions + 1, "2"]) {
      assert.throws(() => new ActivityConsumer({ directory, agentId: "a", endpoint: "http://127.0.0.1:1", validRecord: () => true, slots }),
        /consumer-configuration/, `a cap of ${JSON.stringify(slots)} was taken`);
    }
    assert.equal(new ActivityConsumer({ directory, agentId: "a", endpoint: "http://127.0.0.1:1", validRecord: () => true, slots: 2 }).slots, 2,
      "CONTROL: a smaller cap is taken");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
