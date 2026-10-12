#!/usr/bin/env node
// What an agent's session runs, read when aify-comms asks (0.9.1 3B): the held claim, the answer per agent, and the
// reading kept until its file changes. The readers themselves are tested on real files in actual-model.test.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ModelReader, claudeProjectSlug } from "../lib/actual-model.mjs";
import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";
import { ModelReads, NOT_OFFERED_RETRY_MS } from "../lib/plugins/aify-comms/model-reads.mjs";

const answer = (model) => `${JSON.stringify({ type: "assistant", timestamp: model, message: { model } })}\n`;

test("A REPEAT READ OF AN UNCHANGED TRANSCRIPT is the kept reading; a turn written to it is read again", async () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "model-reader-"));
  const folder = path.join(config, "projects", claudeProjectSlug("C:/w"));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "s-1.jsonl");
  fs.writeFileSync(file, answer("claude-opus-5"));
  let reads = 0;
  const reader = new ModelReader({ env: { CLAUDE_CONFIG_DIR: config }, read: async ({ handle }) => {
    reads += 1;
    return { model: fs.readFileSync(file, "utf8").trim().split("\n").length === 1 ? "first" : "second", handle };
  } });
  const asked = { harness: "claude", workspace: "C:/w", handle: "s-1" };
  assert.deepEqual(await reader.read(asked), { model: "first", handle: "s-1" });
  assert.deepEqual(await reader.read(asked), { model: "first", handle: "s-1" });
  assert.equal(reads, 1, "an unchanged transcript was read twice");
  fs.appendFileSync(file, answer("claude-opus-5-5"));
  assert.deepEqual(await reader.read(asked), { model: "second", handle: "s-1" });
  assert.equal(reads, 2, "a transcript that grew was answered from the kept reading");
});

test("HERMES IS READ AGAIN WHEN ONLY ITS WRITE-AHEAD LOG MOVED, and each session is kept apart", async () => {
  const sizes = { "/h/state.db": 10, "/h/state.db-wal": 5 };
  const stat = (file) => { if (!(file in sizes)) throw Object.assign(Error("absent"), { code: "ENOENT" }); return { size: sizes[file], mtimeMs: 1 }; };
  const asked = [];
  const reader = new ModelReader({ hermesFile: "/h/state.db", stat, read: async ({ handle }) => { asked.push(handle); return { model: `m${asked.length}` }; } });
  await reader.read({ harness: "hermes", handle: "a" });
  await reader.read({ harness: "hermes", handle: "a" });
  await reader.read({ harness: "hermes", handle: "b" });
  assert.deepEqual(asked, ["a", "b"]);
  sizes["/h/state.db-wal"] = 6;
  assert.deepEqual(await reader.read({ harness: "hermes", handle: "a" }), { model: "m3" });
});

test("NOTHING TO READ is answered by the reader itself, uncached: no handle, or a harness not read", async () => {
  const asked = [];
  const reader = new ModelReader({ read: async (q) => { asked.push(q.harness); return { unknown: "x" }; }, stat: () => assert.fail("stat") });
  await reader.read({ harness: "claude", workspace: "/w", handle: "" });
  await reader.read({ harness: "codex", workspace: "/w", handle: "t" });
  await reader.read({ harness: "codex", workspace: "/w", handle: "t" });
  assert.deepEqual(asked, ["claude", "codex", "codex"]);
});

test("A FAILED READ IS NOT KEPT: an unchanged file is read again once the failure clears (review ENV-5)", async () => {
  let reads = 0;
  const reader = new ModelReader({ stat: () => ({ size: 1, mtimeMs: 1 }), hermesFile: "/h/state.db",
    read: async () => (++reads === 1 ? { unknown: "database is locked" } : { model: "m" }) });
  const asked = { harness: "hermes", workspace: "/w", handle: "h" };
  assert.deepEqual(await reader.read(asked), { unknown: "database is locked" });
  assert.deepEqual(await reader.read(asked), { model: "m" });
  assert.deepEqual(await reader.read(asked), { model: "m" });
  assert.equal(reads, 2, "an answer is still kept against its unchanged file");
});

test("A PLUGIN THAT DETACHES while its model-read claim is held answers nothing that claim returns (review ENV-1)", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const answers = [];
  let claims = 0;
  const plugin = createCommsPlugin({ api: { async heartbeat() { return {}; }, async claim() { return {}; },
    async claimControls() { return { controls: [] }; },
    async claimModelReads() { claims += 1; return claims === 1 ? held : new Promise(() => {}); },
    async answerModelRead(...args) { answers.push(args); return { ok: true }; } }, machineId: "m1",
  advertisement: () => ({ kind: "test", hostname: "host" }), cwdRoots: () => [],
  setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} });
  await plugin.start({ processes: { list: () => [] }, log: () => {} });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(claims, 1, "the claim was never held");
  const detaching = plugin.detach();
  release({ reads: [{ readId: "r1", agents: [{ agentId: "a", runtime: "codex", workspace: "/w", sessionHandle: "t" }] }] });
  assert.deepEqual(await detaching, { detached: true, held: 0 });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.deepEqual(answers, [], "a detached plugin answered a read");
});

function api({ reads = [], failure = null } = {}) {
  const calls = { claims: [], answers: [] };
  return {
    calls,
    async claimModelReads(...args) { calls.claims.push(args); if (failure) throw failure; return { reads }; },
    async answerModelRead(...args) { calls.answers.push(args); return { ok: true }; },
  };
}

test("A CLAIMED READ IS ANSWERED per agent, by its runtime's harness, and by this machine", async () => {
  const fake = api({ reads: [{ readId: "r1", agents: [
    { agentId: "a", runtime: "claude-code", workspace: "/w", sessionHandle: "s" },
    { agentId: "b", runtime: "hermes", workspace: "/w", sessionHandle: "h" },
  ] }] });
  const read = async (q) => ({ model: `${q.harness}:${q.handle}` });
  const reads = new ModelReads({ api: fake, machineId: "m1", reader: { read } });
  assert.deepEqual(await reads.pass("env-1"), { outcome: "answered" });
  assert.deepEqual(fake.calls.claims, [["env-1", "m1"]]);
  assert.deepEqual(fake.calls.answers, [["env-1", "r1", "m1", { a: { model: "claude:s" }, b: { model: "hermes:h" } }]]);
});

test("AN OLDER SERVICE without model reads is told apart from an unreachable one", async () => {
  const notOffered = new ModelReads({ api: api({ failure: Object.assign(Error("404"), { status: 404 }) }), machineId: "m" });
  assert.deepEqual(await notOffered.pass("e"), { outcome: "not-offered" });
  const down = new ModelReads({ api: api({ failure: Object.assign(Error("down"), { status: 0 }) }), machineId: "m" });
  assert.deepEqual(await down.pass("e"), { outcome: "unreachable" });
  assert.equal(down.state.lastError, "down");
});

test("THE PLUGIN HOLDS THE CLAIM, answers what it returns, and backs off a service that offers none", async () => {
  const timers = [];
  const fake = api({ reads: [{ readId: "r1", agents: [{ agentId: "a", runtime: "codex", workspace: "/w", sessionHandle: "t" }] }] });
  const plugin = createCommsPlugin({ api: { ...fake, async heartbeat() { return {}; }, async claim() { return {}; },
    async claimControls() { return { controls: [] }; } }, machineId: "m1",
  advertisement: () => ({ kind: "test", hostname: "host" }), cwdRoots: () => [],
  setTimeoutImpl: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
  clearTimeoutImpl: () => {} });
  await plugin.start({ processes: { list: () => [] }, log: () => {} });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(fake.calls.answers.length, 1, "the plugin never answered the read it claimed");
  assert.deepEqual(fake.calls.answers[0][3], { a: { unknown: "codex sessions are not read yet" } });
  assert.equal(plugin.state().modelReads.readsAnswered, 1);
  await plugin.stop();

  const old = api({ failure: Object.assign(Error("404"), { status: 404 }) });
  const pauses = [];
  const second = createCommsPlugin({ api: { ...old, async heartbeat() { return {}; }, async claim() { return {}; },
    async claimControls() { return { controls: [] }; } }, machineId: "m1",
  advertisement: () => ({ kind: "test", hostname: "host" }), cwdRoots: () => [],
  setTimeoutImpl: (callback, ms) => { pauses.push(ms); return {}; }, clearTimeoutImpl: () => {} });
  await second.start({ processes: { list: () => [] }, log: () => {} });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.ok(pauses.includes(NOT_OFFERED_RETRY_MS), `no back-off among the pauses ${pauses}`);
  await second.stop();
});
