// A resident's lifetime record, judged against the OS (lib/resident-lifetimes.mjs; 0.9 plan P0 C3, C4).

import assert from "node:assert/strict";
import { test } from "node:test";

import { currentLifetimes, isoToEpochMicros, parseLifetimeRecord, restoreTurn, verifyLifetime } from "../lib/resident-lifetimes.mjs";

const LIFE = "7f3c9e2a-0000-4000-8000-000000000001";
const OTHER = "7f3c9e2a-0000-4000-8000-000000000002";
const WRITTEN = 1_790_950_000_500_000;  // microseconds
const record = (over = {}) => ({ agentId: "comms-tech-lead", lifetime: LIFE, instance: "default", harness: "claude", pid: 41236,
  launcher: "C:/Users/me/.local/bin/claude-aify", writtenAtUs: WRITTEN, ...over });
const file = (r) => `${r.agentId}.${r.lifetime}.json`;
const probe = (over = {}) => ({ alive: true, createdAtUs: WRITTEN - 2_000_000, commandLine: "bash C:\\Users\\me\\.local\\bin\\claude-aify --resume", ...over });

test("A RECORD IS READ only when every field is what the launcher writes, and its name matches", () => {
  const good = record({ herdrPane: "w1:p3" });
  assert.deepEqual(parseLifetimeRecord(JSON.stringify(good), file(good)), { ok: true, record: good });
  for (const [over, field] of [[{ agentId: "../x" }, "agentId"], [{ lifetime: "not-a-uuid" }, "lifetime"], [{ harness: "pi" }, "harness"],
    [{ pid: 0 }, "pid"], [{ pid: 1.5 }, "pid"], [{ launcher: " " }, "launcher"], [{ writtenAtUs: "1" }, "writtenAtUs"], [{ instance: "" }, "instance"]]) {
    const bad = record(over);
    const parsed = parseLifetimeRecord(JSON.stringify(bad), file(record()));
    assert.equal(parsed.ok, false, field);
  }
  assert.match(parseLifetimeRecord(JSON.stringify(record()), `comms-tech-lead.${OTHER}.json`).problem, /name does not match/);
  assert.match(parseLifetimeRecord("{", file(record())).problem, /not JSON/);
});

test("ADOPTION: created strictly before the write, with the launcher in its command line, is yes and pins the time", () => {
  assert.deepEqual(verifyLifetime(record(), probe()), { verified: "yes", reason: "adopted", pin: WRITTEN - 2_000_000 });
});

test("A REUSED PID is no: created after the write, or with a different pinned time", () => {
  assert.equal(verifyLifetime(record(), probe({ createdAtUs: WRITTEN + 1 })).reason, "reused");
  assert.equal(verifyLifetime(record(), probe(), WRITTEN - 9_000_000).verified, "no", "a different pinned creation");
  assert.equal(verifyLifetime(record(), probe(), WRITTEN - 2_000_000).reason, "pinned", "CONTROL: the same pinned creation is yes");
});

test("EQUAL TO THE WRITE IS UNKNOWN: indistinguishable from a pid born just after it (N3)", () => {
  assert.deepEqual(verifyLifetime(record(), probe({ createdAtUs: WRITTEN })), { verified: "unknown", reason: "equal-to-write", pin: null });
  assert.equal(verifyLifetime(record(), probe({ createdAtUs: WRITTEN - 1 })).verified, "yes", "CONTROL: one microsecond before is yes");
});

test("A SIBLING (no launcher in its command line) is no; a gone pid is no; an unanswered probe is unknown", () => {
  assert.equal(verifyLifetime(record(), probe({ commandLine: "node C:/other/server.js" })).reason, "sibling");
  assert.equal(verifyLifetime(record(), { alive: false, createdAtUs: null, commandLine: null }).reason, "gone");
  for (const unanswered of [{ alive: null }, { alive: true, createdAtUs: null }, { alive: true, commandLine: null }]) {
    assert.equal(verifyLifetime(record(), probe(unanswered)).verified, "unknown", JSON.stringify(unanswered));
  }
  assert.equal(verifyLifetime(record(), { alive: null, createdAtUs: null, commandLine: null }, 5).pin, 5, "an unknown keeps its pin");
});

test("TWO VERIFIED LIFETIMES ARE A CONFLICT, never resolved by picking; one is current", () => {
  const a = record();
  const b = record({ lifetime: OTHER, writtenAtUs: WRITTEN + 10 });
  const both = currentLifetimes([{ record: a, verified: "yes" }, { record: b, verified: "yes" }]).get("comms-tech-lead");
  assert.equal(both.current, null);
  assert.deepEqual(both.conflict, [a, b]);
  const one = currentLifetimes([{ record: a, verified: "no" }, { record: b, verified: "yes" }]).get("comms-tech-lead");
  assert.deepEqual([one.current, one.conflict], [b, null], "CONTROL: an ended lifetime beside a live one is no conflict");
  const unsure = currentLifetimes([{ record: a, verified: "unknown" }]).get("comms-tech-lead");
  assert.deepEqual([unsure.current, unsure.unknown], [null, [a]], "an unknown is kept, not current");
});

test("A STORED TURN after a restart: restored for yes, closed for no, kept unrenewed for unknown (C3)", () => {
  const turn = { lifetime: LIFE, startedAtUs: 1, lastEventAtUs: 2 };
  assert.deepEqual(restoreTurn(turn, "yes"), { keep: true, renewable: true, cause: "restored" });
  assert.deepEqual(restoreTurn(turn, "no"), { keep: false, renewable: false, cause: "lifetime-ended" });
  assert.deepEqual(restoreTurn(turn, "unknown"), { keep: true, renewable: false, cause: "identity-unknown" });
});

test("WINDOWS' 7-DIGIT CREATION TIME keeps its microseconds, which Date.parse would drop", () => {
  assert.equal(isoToEpochMicros("2026-10-02T15:00:00.1234567Z"), Date.parse("2026-10-02T15:00:00Z") * 1000 + 123456);
  assert.equal(isoToEpochMicros("2026-10-02T15:00:00Z"), Date.parse("2026-10-02T15:00:00Z") * 1000);
  assert.equal(isoToEpochMicros("2026-10-02T18:00:00.5+03:00"), Date.parse("2026-10-02T15:00:00Z") * 1000 + 500000);
  assert.equal(isoToEpochMicros("yesterday"), null);
  assert.notEqual(isoToEpochMicros("2026-10-02T15:00:00.1234567Z") % 1000, 0, "CONTROL: sub-millisecond digits survive");
});
