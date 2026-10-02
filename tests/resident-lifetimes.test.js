// A resident's lifetime record, judged against the OS (lib/resident-lifetimes.mjs; 0.9 plan P0 C3, C4).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { currentLifetimes, isoToEpochMicros, parseLifetimeRecord, verifyLifetime, windowsArguments } from "../lib/resident-lifetimes.mjs";

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
    [{ pid: 0 }, "pid"], [{ pid: 1.5 }, "pid"], [{ launcher: " " }, "launcher"], [{ writtenAtUs: "1" }, "writtenAtUs"], [{ instance: "" }, "instance"],
    [{ writtenAtUs: 1_790_950_000_500 }, "writtenAtUs"], [{ herdrPane: 3 }, "herdrPane"]]) {
    const bad = record(over);
    // Named by its own fields where it can be, so each check is the one that refuses it, not the name check.
    const name = typeof bad.agentId === "string" && typeof bad.lifetime === "string" ? file(bad) : file(record());
    const parsed = parseLifetimeRecord(JSON.stringify(bad), name);
    assert.equal(parsed.ok, false, field);
    assert.match(parsed.problem, new RegExp(`: ${field}$`), `${field}: refused by its own check`);
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

test("THE LAUNCHER is one whole argument in any spelling Windows reports, and anything else is unknown, never no", () => {
  const bs = String.fromCharCode(92);
  for (const commandLine of [`"C:${bs}Program Files${bs}Git${bs}usr${bs}bin${bs}bash.exe" /c/Users/me/.local/bin/claude-aify --resume`,
    `bash "C:${bs}USERS${bs}me${bs}.local${bs}bin${bs}claude-aify"`, "bash C:/Users/me/.local/bin/claude-aify"]) {
    assert.equal(verifyLifetime(record(), probe({ commandLine })).verified, "yes", commandLine);
  }
  for (const commandLine of ["bash /c/Users/me/.local/bin/claude-aify-old", "bash /c/Users/me/.local/bin/claude-aify.bak/run",
    "node C:/other/server.js"]) {
    assert.deepEqual(verifyLifetime(record(), probe({ commandLine })), { verified: "unknown", reason: "launcher-unmatched", pin: null }, commandLine);
  }
});


const ARGV = JSON.parse(fs.readFileSync(new URL("./fixtures/windows-argv.json", import.meta.url), "utf8"));

test("WINDOWS SPLITS A COMMAND LINE as this does, on every recorded line", () => {
  assert.ok(ARGV.rows.length >= 15);
  for (const row of ARGV.rows) assert.deepEqual(windowsArguments(row.commandLine), row.native, row.commandLine);
});

test("THE RECORDED SPLIT IS STILL WINDOWS' OWN", { skip: process.platform !== "win32" && "the native split exists only on Windows" }, () => {
  const echo = fileURLToPath(new URL("./fixtures/argv-echo.cjs", import.meta.url));
  for (const row of ARGV.rows) {
    const run = spawnSync(process.execPath, [echo, row.commandLine], { windowsVerbatimArguments: true, encoding: "utf8" });
    assert.deepEqual(JSON.parse(run.stdout), row.native, row.commandLine);
  }
});

test("A QUOTED PREFIX IS NOT THE LAUNCHER: the argument Windows hands the process is (L1)", () => {
  const quoted = (tail) => verifyLifetime(record({ launcher: "C:/Users/me/.local/bin/claude-aify" }), probe({ commandLine: `bash.exe ${tail}` })).verified;
  assert.equal(quoted('"C:/Users/me/.local/bin/claude-aify"-old'), "unknown", "the argument is claude-aify-old");
  assert.equal(quoted('"C:/Users/me/.local/bin/claude-aify"'), "yes", "CONTROL: fully quoted");
  assert.equal(quoted('"C:/Users/me"/.local/bin/claude-aify --resume'), "yes", "partly quoted, and still exactly the launcher");
});
test("A GONE PID is no; an unanswered probe, or one with no creation time, is unknown", () => {
  assert.equal(verifyLifetime(record(), probe({ createdAtUs: 0 })).verified, "unknown", "a creation at 0 is no answer");
  assert.equal(verifyLifetime(record(), { alive: false, createdAtUs: null, commandLine: null }).reason, "gone");
  for (const unanswered of [{ alive: null }, { alive: true, createdAtUs: null }, { alive: true, commandLine: null }]) {
    assert.equal(verifyLifetime(record(), probe(unanswered)).verified, "unknown", JSON.stringify(unanswered));
  }
  assert.equal(verifyLifetime(record(), { alive: null, createdAtUs: null, commandLine: null }, 5).pin, 5, "an unknown keeps its pin");
});

test("TWO VERIFIED LIFETIMES ARE A CONFLICT, never resolved by picking; one is current", () => {
  const a = record();
  const b = record({ lifetime: OTHER, writtenAtUs: WRITTEN + 10 });
  const here = { instance: "default" };
  const both = currentLifetimes([{ record: a, verified: "yes" }, { record: b, verified: "yes" }], here).get("comms-tech-lead");
  assert.equal(both.current, null);
  assert.deepEqual(both.conflict, [a, b]);
  const one = currentLifetimes([{ record: a, verified: "no" }, { record: b, verified: "yes" }], here).get("comms-tech-lead");
  assert.deepEqual([one.current, one.conflict], [b, null], "CONTROL: an ended lifetime beside a live one is no conflict");
  const unsure = currentLifetimes([{ record: a, verified: "unknown" }], here).get("comms-tech-lead");
  assert.deepEqual([unsure.current, unsure.unknown], [null, [a]], "an unknown is kept, not current");
  const twice = currentLifetimes([{ record: a, verified: "yes" }, { record: a, verified: "yes" }], here).get("comms-tech-lead");
  assert.deepEqual([twice.current, twice.conflict], [a, null], "one record read twice is one lifetime");
});

test("ANOTHER INSTANCE: its lifetime is never current here, and one agent verified under two instances is a conflict (C4)", () => {
  const theirs = record({ instance: "work" });
  const elsewhere = currentLifetimes([{ record: theirs, verified: "yes" }], { instance: "default" }).get("comms-tech-lead");
  assert.deepEqual([elsewhere.current, elsewhere.conflict, elsewhere.unknown], [null, null, []]);
  const unsureThere = currentLifetimes([{ record: theirs, verified: "unknown" }], { instance: "default" }).get("comms-tech-lead");
  assert.deepEqual(unsureThere.unknown, [], "another instance's unknown lifetime is not this one's to retain");
  const ours = record({ lifetime: OTHER });
  const split = currentLifetimes([{ record: theirs, verified: "yes" }, { record: ours, verified: "yes" }], { instance: "default" }).get("comms-tech-lead");
  assert.deepEqual([split.current, split.conflict], [null, [theirs, ours]]);
  assert.equal(currentLifetimes([{ record: ours, verified: "yes" }], { instance: "default" }).get("comms-tech-lead").current, ours,
    "CONTROL: this instance's own lifetime is current");
  assert.throws(() => currentLifetimes([], {}), /instance/);
});

test("WINDOWS' 7-DIGIT CREATION TIME keeps its microseconds, which Date.parse would drop", () => {
  assert.equal(isoToEpochMicros("2026-10-02T15:00:00.1234567Z"), Date.parse("2026-10-02T15:00:00Z") * 1000 + 123456);
  assert.equal(isoToEpochMicros("2026-10-02T15:00:00Z"), Date.parse("2026-10-02T15:00:00Z") * 1000);
  assert.equal(isoToEpochMicros("2026-10-02T18:00:00.5+03:00"), Date.parse("2026-10-02T15:00:00Z") * 1000 + 500000);
  assert.equal(isoToEpochMicros("2026-10-02T10:00:00.25-05:00"), Date.parse("2026-10-02T15:00:00Z") * 1000 + 250000, "a host west of UTC");
  assert.equal(isoToEpochMicros("yesterday"), null);
  assert.notEqual(isoToEpochMicros("2026-10-02T15:00:00.1234567Z") % 1000, 0, "CONTROL: sub-millisecond digits survive");
});
