#!/usr/bin/env node
// What this environment owns, written down where a LATER instance can read it.
//
// The registry is in memory, so a daemon that dies takes its knowledge with it and every agent it
// started keeps running with nobody able to name them. The operator asked for two things -- kill the
// managed processes when aify-env dies, and track everything it spawns -- and they are the same
// mechanism: you cannot reap what you did not record.
//
// STATE, NOT EVENTS. A shutdown handler covers the graceful paths and misses the one that matters: a
// hard kill runs no handler at all. So the record on disk is the authority, and the next instance
// reaps from it at startup. This repo has an incident behind that rule -- cleanup that must hold for
// ALL paths has to key on state.
//
// FAILS SAFE, ALWAYS. An unreadable or corrupt record must never stop the environment starting: a
// process manager that refuses to run because its bookkeeping is damaged has turned a leak into an
// outage.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readOwned, recordStarted, recordStopped, clearOwned } from "../lib/owned-processes.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-owned-")), "owned.json");

test("a started process is written down, and reads back", () => {
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 4242, service: "aify-comms", launcher: "/l/claude-aify", startedAt: 1000 });
  assert.deepEqual(readOwned(file), [
    { id: "p1", pid: 4242, service: "aify-comms", launcher: "/l/claude-aify", startedAt: 1000, owner: process.pid },
  ]);
});

test("the writing instance stamps itself as the OWNER, without being asked", () => {
  // Not optional, and not the caller's job to remember. `owner` is what lets a later instance tell an
  // orphan from another LIVE instance's process, and the entry that most needs it is the one written
  // by code that has never heard of the field. Defaulting to `process.pid` at the write site is what
  // makes every entry carry it. See a-live-owners-processes-are-not-orphans.test.js for the incident.
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 4242, service: "aify-comms" });
  assert.equal(readOwned(file)[0].owner, process.pid);
});

test("an explicit owner is honoured over the default", () => {
  // A caller recording on another instance's behalf must be able to say so, rather than silently
  // claiming the entry.
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 4242, service: "aify-comms", owner: 12345 });
  assert.equal(readOwned(file)[0].owner, 12345);
});

test("several processes accumulate, and stopping removes only its own", () => {
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 1, service: "a", startedAt: 1 });
  recordStarted(file, { id: "p2", pid: 2, service: "b", startedAt: 2 });
  recordStopped(file, "p1");
  assert.deepEqual(readOwned(file).map((e) => e.id), ["p2"]);
});

test("stopping something unknown is not an error", () => {
  // A reaper racing a stop must not throw for having been second.
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 1, service: "a", startedAt: 1 });
  recordStopped(file, "never-existed");
  assert.equal(readOwned(file).length, 1);
});

test("a missing file is no processes, not an error", () => {
  assert.deepEqual(readOwned(path.join(os.tmpdir(), "aify-owned-does-not-exist", "x.json")), []);
});

test("a CORRUPT record reads as empty rather than throwing", () => {
  // The environment must still start. Refusing to run because the bookkeeping is damaged turns a leak
  // into an outage, and the record is rebuilt by the processes started next.
  const file = tmp();
  fs.writeFileSync(file, "{not json at all");
  assert.deepEqual(readOwned(file), []);
});

test("entries that are not process records are dropped, not trusted", () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify([{ id: "ok", pid: 5, service: "s", startedAt: 1 }, 42, null, { id: "no-pid" }]));
  assert.deepEqual(readOwned(file).map((e) => e.id), ["ok"]);
});

test("clearOwned empties the record", () => {
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 1, service: "a", startedAt: 1 });
  clearOwned(file);
  assert.deepEqual(readOwned(file), []);
});

test("recording survives a reader that never saw the file created", () => {
  // The whole point: a DIFFERENT process must be able to read what this one owns.
  const file = tmp();
  recordStarted(file, { id: "p1", pid: 99, service: "aify-comms", startedAt: 7 });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Array.isArray(raw), true, "the record must be plain JSON another tool can read");
  assert.equal(raw[0].pid, 99);
});
