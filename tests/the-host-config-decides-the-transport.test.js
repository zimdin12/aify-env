#!/usr/bin/env node
// `~/.aify/config.json`: host preferences several tiers read, and the rule that it can never stop
// anything from starting.
//
// WHY THESE CASES. A preference file is read at the worst moment -- daemon start, and every attach
// -- so the failure that matters is not a wrong value, it is a file that throws. Missing, empty,
// truncated mid-write, or JSON of the wrong shape: every one of them must yield the default rather
// than an exception. A flag written as a WORD is not the wrong shape: it is read with the same words
// the environment variable accepts, because the default is ON and `"false"` read as "no opinion"
// is the opposite of what the operator wrote.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HOST_SETTINGS, flagFromEnv, hostConfigFrom, withHostSetting } from "../lib/host-config.mjs";

test("with no file and no environment, the local socket is on", () => {
  assert.equal(hostConfigFrom(null, {}).localSocket, true);
  assert.equal(hostConfigFrom(null, {}).localSocketSource, "default");
  assert.equal(HOST_SETTINGS.localSocket.default, true, "the default is the documented one");
});

test("the file turns it off, and says so when asked where the value came from", () => {
  const config = hostConfigFrom(JSON.stringify({ version: 1, transport: { localSocket: false } }), {});
  assert.equal(config.localSocket, false);
  assert.equal(config.localSocketSource, "file");
});

test("the environment beats the file, in both directions", () => {
  const off = JSON.stringify({ transport: { localSocket: false } });
  assert.equal(hostConfigFrom(off, { AIFY_ENV_LOCAL_SOCKET: "1" }).localSocket, true);
  assert.equal(hostConfigFrom(off, { AIFY_ENV_LOCAL_SOCKET: "1" }).localSocketSource, "env");
  const on = JSON.stringify({ transport: { localSocket: true } });
  assert.equal(hostConfigFrom(on, { AIFY_ENV_LOCAL_SOCKET: "0" }).localSocket, false);
});

test("a file that cannot be used yields the default rather than throwing", () => {
  for (const text of ["", "   ", "{", "not json at all", "[]", "null", '{"transport": 7}',
                      '{"transport": {"localSocket": "maybe"}}', '{"transport": {"localSocket": {}}}']) {
    assert.equal(hostConfigFrom(text, {}).localSocket, true, `refused to default on: ${text}`);
  }
});

test("a flag the operator wrote as a word is read as that word, not as no opinion", () => {
  // A hand-edited `"localSocket": "false"` fell through to the default, which is ON -- the one
  // outcome the operator had just written down that they did not want.
  for (const word of ["false", "off", "no", "0", " FALSE "]) {
    const config = hostConfigFrom(JSON.stringify({ transport: { localSocket: word } }), {});
    assert.equal(config.localSocket, false, word);
    assert.equal(config.localSocketSource, "file", word);
  }
  assert.equal(hostConfigFrom(JSON.stringify({ transport: { localSocket: 0 } }), {}).localSocket, false);
});

test("only words that mean something are read from the environment", () => {
  for (const raw of ["1", "true", "TRUE", "yes", "on"]) assert.equal(flagFromEnv({ X: raw }, "X"), true, raw);
  for (const raw of ["0", "false", "no", "off"]) assert.equal(flagFromEnv({ X: raw }, "X"), false, raw);
  // Anything else is NOT an opinion, and must not be read as one: "maybe" is not false.
  for (const raw of ["", "  ", "maybe", "2", "null"]) assert.equal(flagFromEnv({ X: raw }, "X"), null, raw);
});

test("writing a setting keeps every other key the file holds", () => {
  // Another tier may already own keys here. An installer that rewrote the file wholesale would
  // delete them, which is the mistake the service registry documents at length.
  const before = JSON.stringify({ version: 1, somebodyElse: { keep: "me" }, transport: { other: true } });
  const after = JSON.parse(withHostSetting(before, "localSocket", false));
  assert.deepEqual(after.somebodyElse, { keep: "me" });
  assert.equal(after.transport.other, true);
  assert.equal(after.transport.localSocket, false);
  assert.equal(after.version, 1);
});

test("writing a setting into a damaged file starts a sound one rather than failing", () => {
  const after = JSON.parse(withHostSetting("{ truncated", "localSocket", true));
  assert.deepEqual(after, { version: 1, transport: { localSocket: true } });
});

test("another tier's `version` survives an aify-env install", () => {
  // EXTERNAL REVIEW, 2026-09-21, finding F. `withHostSetting` wrote `version: 1` unconditionally,
  // inside the one function whose whole purpose is to leave other tiers' keys alone -- so a file
  // another tier had stamped came back renumbered the moment an operator reinstalled aify-env.
  const theirs = JSON.stringify({ version: 2, wrapper: { theme: "dark" } });
  const written = JSON.parse(withHostSetting(theirs, "localSocket", false));
  assert.equal(written.version, 2, "the version belongs to whoever stamped it, not to this writer");
  assert.deepEqual(written.wrapper, { theme: "dark" }, "and the rest of their file is still there");
  assert.equal(written.transport.localSocket, false);
});

test("a file nobody has stamped still gets a version", () => {
  // The control: absent is not the same as set, and a file this writer created needs the field.
  assert.equal(JSON.parse(withHostSetting("", "localSocket", true)).version, 1);
  assert.equal(JSON.parse(withHostSetting("{}", "localSocket", true)).version, 1);
  // Unreadable JSON is replaced rather than merged -- there is nothing in it to preserve.
  assert.equal(JSON.parse(withHostSetting("not json at all", "localSocket", true)).version, 1);
});

test("the installer leaves an operator's value alone, whatever type they wrote it as", (t) => {
  // It checked `typeof === "boolean"`, so a hand-written `"false"` was replaced with `true` on the
  // next reinstall -- the installer overruling the operator, which is the one thing it promises not
  // to do. Presence is the answer; what the value means is the reader's business.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-host-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, ".aify", "config.json");
  fs.mkdirSync(path.dirname(file));
  const theirs = `${JSON.stringify({ version: 1, transport: { localSocket: "false" } })}\n`;
  fs.writeFileSync(file, theirs);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-host-config.mjs");
  execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(fs.readFileSync(file, "utf8"), theirs);
});
