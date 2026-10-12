#!/usr/bin/env node
// What an agent's session actually runs, read from the harness's own record (0.9.1). Each reader is driven
// against a real file of the harness's shape in a temporary directory; nothing reads this host's sessions.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TAIL_BYTES, actualModel, claudeActual, claudeProjectSlug, hermesActual, hermesStateDb, latestClaudeAnswer,
} from "../lib/actual-model.mjs";

const answer = (model, timestamp) => JSON.stringify({ type: "assistant", timestamp, message: { model } });

test("CLAUDE'S FOLDER NAME for a workspace: the folder this host's own sessions are in", () => {
  // OBSERVED 2026-10-12: ~/.claude/projects/C--Docker-aify-comms holds the sessions started in C:\Docker\aify-comms.
  assert.equal(claudeProjectSlug("C:\\Docker\\aify-comms"), "C--Docker-aify-comms");
  assert.equal(claudeProjectSlug("C:/Docker/aify-comms"), "C--Docker-aify-comms");
  assert.equal(claudeProjectSlug("/home/me/my.proj"), "-home-me-my-proj");
});

test("THE NEWEST ANSWER wins; a cut first line, the user's lines and Claude's own synthetic ones are skipped", () => {
  const text = ['l":"cut', answer("claude-opus-5", "t1"), JSON.stringify({ type: "user", message: { content: "hi" } }),
    answer("claude-opus-5-5", "t2"), answer("<synthetic>", "t3"), ""].join("\n");
  assert.deepEqual(latestClaudeAnswer(text), { model: "claude-opus-5-5", at: "t2" });
  assert.equal(latestClaudeAnswer(JSON.stringify({ type: "user" })), null);
});

test("A CLAUDE SESSION is read by its handle, from the tail of a transcript longer than the tail", () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "actual-claude-"));
  const folder = path.join(config, "projects", claudeProjectSlug("C:/w"));
  fs.mkdirSync(folder, { recursive: true });
  const filler = answer("claude-opus-5", "old").padEnd(TAIL_BYTES + 10, " ");
  fs.writeFileSync(path.join(folder, "s-1.jsonl"), `${answer("claude-sonnet-5", "older")}\n${filler}\n${answer("claude-opus-5-5", "new")}\n`);
  const env = { CLAUDE_CONFIG_DIR: config };
  assert.deepEqual(claudeActual({ workspace: "C:/w", handle: "s-1", env }), { model: "claude-opus-5-5", at: "new" });
  assert.match(claudeActual({ workspace: "C:/w", handle: "s-2", env }).unknown, /no transcript at .*s-2\.jsonl/);
  assert.deepEqual(claudeActual({ workspace: "C:/w", handle: "", env }), { unknown: "no session handle" });
});

test("A HANDLE THAT IS NOT A SESSION ID reads nothing, so it cannot reach a file outside Claude's projects (review ENV-2)", () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "actual-claude-escape-"));
  const folder = path.join(config, "projects", claudeProjectSlug("C:/w"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(config, "outside.jsonl"), answer("from-outside", "t"));
  const env = { CLAUDE_CONFIG_DIR: config };
  for (const handle of ["../../outside", "..\\..\\outside", path.join(config, "outside"), "a/b", "."]) {
    assert.match(claudeActual({ workspace: "C:/w", handle, env }).unknown, /is not a Claude session id/, handle);
  }
  // A regular file only: a directory (or a FIFO, which would block the read) under a session id's name is not one.
  fs.mkdirSync(path.join(folder, "s-dir.jsonl"));
  assert.match(claudeActual({ workspace: "C:/w", handle: "s-dir", env }).unknown, /ENOTFILE/);
});

test("A CLAUDE SESSION STARTED ELSEWHERE than the workspace it registered from is found by its own id", () => {
  // OBSERVED 2026-10-12: llama-manager registered from C:/Docker/aify-llamacpp, its transcript is under the router's folder.
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "actual-claude-elsewhere-"));
  const folder = path.join(config, "projects", claudeProjectSlug("C:/Docker/aify-llamacpp-router"));
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(config, "projects", "C--other"), { recursive: true });
  fs.writeFileSync(path.join(folder, "s-9.jsonl"), answer("claude-opus-5-5", "t"));
  const env = { CLAUDE_CONFIG_DIR: config };
  assert.deepEqual(claudeActual({ workspace: "C:/Docker/aify-llamacpp", handle: "s-9", env }), { model: "claude-opus-5-5", at: "t" });
  assert.match(claudeActual({ workspace: "C:/Docker/aify-llamacpp", handle: "s-8", env }).unknown,
    /no transcript at .*C--Docker-aify-llamacpp[\\/]s-8\.jsonl/, "a missing session must name where it was expected");
});

test("A HERMES SESSION is its newest own turn, not a side task's model and not another session's", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "actual-hermes-")), "state.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, task TEXT NOT NULL DEFAULT '', first_seen REAL, last_seen REAL)");
  const insert = db.prepare("INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?)");
  insert.run("h-1", "gpt-6-sol", "", 1, 1790000000);
  insert.run("h-1", "gpt-6.1-sol", "", 2, 1790000100);
  insert.run("h-1", "cheap-model", "compression", 3, 1790000200);
  insert.run("h-2", "other", "", 4, 1790000300);
  db.close();
  assert.deepEqual(await hermesActual({ handle: "h-1", file }), { model: "gpt-6.1-sol", at: new Date(1790000100 * 1000).toISOString() });
  assert.match((await hermesActual({ handle: "h-9", file })).unknown, /no turn of session h-9/);
  assert.match((await hermesActual({ handle: "h-1", file: `${file}.missing` })).unknown, /no hermes state/);
  assert.match((await hermesActual({ handle: "h-1", file, sqlite: async () => { throw new Error("x"); } })).unknown, /no node:sqlite/);
});

test("WHERE HERMES KEEPS ITS STATE: HERMES_HOME, else the platform default", () => {
  assert.equal(hermesStateDb({ env: { HERMES_HOME: "/h" }, platform: "linux", homedir: "/home/me" }), path.join("/h", "state.db"));
  assert.equal(hermesStateDb({ env: {}, platform: "linux", homedir: "/home/me" }), path.join("/home/me", ".hermes", "state.db"));
  assert.equal(hermesStateDb({ env: { LOCALAPPDATA: "C:/L" }, platform: "win32", homedir: "C:/u" }), path.join("C:/L", "hermes", "state.db"));
});

test("A HARNESS NOT READ YET is UNKNOWN by name", async () => {
  assert.deepEqual(await actualModel({ harness: "codex", workspace: "/w", handle: "t" }), { unknown: "codex sessions are not read yet" });
});
