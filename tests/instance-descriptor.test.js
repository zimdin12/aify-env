// Where an instance listens, for its agents' hooks (lib/instance-descriptor.mjs; 0.9 plan P0 C4).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { descriptorFile, parseDescriptor, writeDescriptor } from "../lib/instance-descriptor.mjs";
import { isLoopbackEndpoint } from "../lib/serving-endpoint.mjs";

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-descriptor-"));
const mine = { url: "http://127.0.0.1:63204", instance: "default", pid: 4242, startedAt: "2026-10-02T20:00:00.000Z" };

test("AN INSTANCE WRITES WHERE IT LISTENS, and a hook reads it back", () => {
  const file = descriptorFile(home(), "default");
  assert.ok(file.endsWith(path.join("env", "default.json")));
  writeDescriptor(file, mine);
  assert.deepEqual(parseDescriptor(fs.readFileSync(file, "utf8")), { ok: true, descriptor: mine });
});

test("A DESCRIPTOR AIMS ONLY AT THIS HOST, and every field is what an instance writes", () => {
  for (const [over, problem] of [[{ url: "http://10.0.0.5:8802" }, /loopback/], [{ url: "http://localhost:8802" }, /loopback/],
    [{ url: "https://127.0.0.1:8802" }, /loopback/], [{ url: "http://127.0.0.1:8802/path" }, /loopback/], [{ instance: "" }, /instance/],
    [{ url: ["http://127.0.0.1:8802"] }, /loopback/], [{ url: { toString: "x" } }, /loopback/],
    [{ pid: 0 }, /pid/], [{ pid: "4242" }, /pid/], [{ startedAt: "yesterday" }, /startedAt/]]) {
    const parsed = parseDescriptor(JSON.stringify({ ...mine, ...over }));
    assert.equal(parsed.ok, false, JSON.stringify(over));
    assert.match(parsed.problem, problem, JSON.stringify(over));
  }
  assert.match(parseDescriptor("{").problem, /not JSON/);
  assert.match(parseDescriptor("[]").problem, /not an object/);
  assert.equal(isLoopbackEndpoint("http://127.0.0.1:1"), true, "CONTROL: the receipts' own rule accepts loopback");
  assert.equal(isLoopbackEndpoint(undefined), false);
});

test("AN INSTANCE NEVER WRITES A DESCRIPTOR IT WOULD REFUSE TO READ", () => {
  const file = descriptorFile(home(), "default");
  assert.throws(() => writeDescriptor(file, { ...mine, url: "http://10.0.0.5:8802" }), /loopback/);
  assert.equal(fs.existsSync(file), false);
});

test("A SUCCESSOR'S DESCRIPTOR REPLACES ITS PREDECESSOR'S, and nothing removes one", () => {
  const file = descriptorFile(home(), "default");
  writeDescriptor(file, mine);
  writeDescriptor(file, { ...mine, pid: 5000, url: "http://127.0.0.1:50000" });
  assert.deepEqual(parseDescriptor(fs.readFileSync(file, "utf8")).descriptor, { ...mine, pid: 5000, url: "http://127.0.0.1:50000" });
});
