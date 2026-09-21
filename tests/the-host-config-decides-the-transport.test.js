#!/usr/bin/env node
// `~/.aify/config.json`: host preferences several tiers read, and the rule that it can never stop
// anything from starting.
//
// WHY THESE CASES. A preference file is read at the worst moment -- daemon start, and every attach
// -- so the failure that matters is not a wrong value, it is a file that throws. Missing, empty,
// truncated mid-write, JSON of the wrong shape, or a boolean written as a string: every one of them
// must yield the default rather than an exception, and the default must be the transport that works.

import assert from "node:assert/strict";
import { test } from "node:test";

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
                      '{"transport": {"localSocket": "yes"}}']) {
    assert.equal(hostConfigFrom(text, {}).localSocket, true, `refused to default on: ${text}`);
  }
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
