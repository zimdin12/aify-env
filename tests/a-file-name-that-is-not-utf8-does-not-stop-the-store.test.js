#!/usr/bin/env node
// ONE FILE NAME THAT IS NOT UTF-8 STOPPED EVERY CALL TO THE DEFINITION STORE (0.8.5 review, F6).
//
// Measured on this host: a `*.json` entry whose name is not valid UTF-8 (on Windows a lone surrogate, which
// Node hands over as the WTF-8 bytes ED A0 80) came back from a string `readdirSync` with U+FFFD in place of
// the bad bytes. That decoded name is not the file's name, so the `lstatSync` on it threw ENOENT, which is not
// an "unreadable" code, so the scan rethrew and every list, set, remove and snapshot failed until the file
// was renamed by hand. The scan now lists names as bytes, and a name that does not survive a UTF-8 round trip
// is an invalid entry, as a directory standing where a definition should be already is.
//
// Driven through the injectable `readdirSync`, because a name like this cannot be made portably: the fake
// returns one extra entry in whichever form the store asked for -- the bytes when it asks for a Buffer, the
// lossy string when it does not -- which is exactly what the real call does.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const agent = (over = {}) => ({
  name: "Coder One", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w",
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true, ...over,
});
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-defs-name-"));
// `bad`, the byte 0xFF (never valid UTF-8), `.json`.
const BAD_NAME = Buffer.concat([Buffer.from("bad"), Buffer.from([0xff]), Buffer.from(".json")]);
const DECODED_ID = "bad\uFFFD";

/** The real listing of `dir`, plus one regular file named BAD_NAME, in the encoding the caller asked for. */
const withBadName = (dir) => (target, options) => {
  const real = fs.readdirSync(target, options);
  if (path.resolve(target) !== path.resolve(dir)) return real;
  const name = options?.encoding === "buffer" ? BAD_NAME : BAD_NAME.toString("utf8");
  return [...real, { name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }];
};

test("a definition file name that is not UTF-8 is an invalid entry, and every call still works", async () => {
  const dir = tempDir();
  const store = new DefinitionStore({ dir, lockWaitMs: 300, readdirSync: withBadName(dir) });
  await store.set("a", agent(), { installed: ALL });
  const listed = await store.list();
  assert.deepEqual(listed.definitions.map((d) => [d.id, d.problems]), [
    ["a", []],
    [DECODED_ID, ["entry: name-not-utf8"]],
  ]);
  // Every public call goes through the same scan; the first version failed them all.
  await store.set("b", agent({ name: "Second" }), { installed: ALL });
  const snap = await store.snapshot({ installed: ALL });
  assert.deepEqual(snap.entries.map((e) => [e.id, e.state]), [["a", "valid"], ["b", "valid"], [DECODED_ID, "invalid"]]);
  await store.remove("b");
  assert.equal(fs.existsSync(path.join(dir, ".lock")), false, "no call left its lock behind");
  // Adoption never takes the entry in: the ledger holds only the ids that were set.
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, ".collection.json"), "utf8"));
  assert.deepEqual(Object.keys(ledger.ids).sort(), ["a"]);
});

test("control: a valid non-ASCII name (ä.json) is listed under its own name, not as a bad one", async () => {
  const dir = tempDir();
  const store = new DefinitionStore({ dir, lockWaitMs: 300 });
  await store.set("a", agent(), { installed: ALL });
  fs.writeFileSync(path.join(dir, "ä.json"), fs.readFileSync(path.join(dir, "a.json")));
  const byId = Object.fromEntries((await store.list()).definitions.map((d) => [d.id, d.problems]));
  assert.ok("ä" in byId, `ä.json is listed: ${JSON.stringify(byId)}`);
  assert.ok(!byId["ä"].includes("entry: name-not-utf8"), `judged on its id, not its name's bytes: ${byId["ä"]}`);
});
