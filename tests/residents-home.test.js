// The residents role's names, derived from the home's identity (B1 contract items 1-3, 6). Pure: the realpath is the
// OS's own here, on directories this test makes; every other input is a value.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RESIDENTS, aifyHomeOf, crossOsHomeReason, homeIdentity, residentsPublisherInstance, roleEndpoint } from "../lib/residents-home.mjs";

const real = { platform: process.platform, realpath: fs.realpathSync.native };

test("the home is <os home>/.aify, and the role's local name is residents", () => {
  assert.equal(aifyHomeOf(path.join("x", "home")), path.join("x", "home", ".aify"));
  assert.equal(RESIDENTS, "residents");
});

test("one directory spelled two ways on one OS is one identity; two directories are two", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "aify-home-id-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a", ".aify"), b = path.join(root, "b", ".aify");
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  const link = path.join(root, "link");
  fs.symlinkSync(path.join(root, "a"), link, process.platform === "win32" ? "junction" : "dir");
  const spellings = [path.join(link, ".aify"), path.join(root, "a", "x", "..", ".aify")];
  if (process.platform === "win32") spellings.push(a.toUpperCase(), a.split(path.sep).join("/"));
  const one = homeIdentity(a, real);
  assert.equal(one.ok, true);
  for (const spelling of spellings) assert.deepEqual(homeIdentity(spelling, real), one, spelling);
  assert.notDeepEqual(homeIdentity(b, real), one, "two homes are two identities");
  assert.notEqual(roleEndpoint(homeIdentity(b, real).identity, process.platform), roleEndpoint(one.identity, process.platform));
  assert.deepEqual(homeIdentity(path.join(root, "absent"), real).ok, false, "a home that does not resolve has no identity");
});

test("Windows folds case; Linux keeps it", () => {
  const realpath = (dir) => dir;
  assert.deepEqual(homeIdentity("C:\\Users\\Me\\.aify", { platform: "win32", realpath }), { ok: true, identity: "c:\\users\\me\\.aify" });
  assert.deepEqual(homeIdentity("/home/Me/.aify", { platform: "linux", realpath }), { ok: true, identity: "/home/Me/.aify" });
  assert.match(homeIdentity("x", { platform: "linux", realpath: () => { throw Object.assign(new Error(), { code: "EACCES" }); } }).reason,
    /home-unresolvable: EACCES/);
});

test("a home shared across operating systems is refused for the role, and an ordinary one is not", () => {
  const rows = [
    ["win32", "\\\\wsl$\\ubuntu\\home\\me\\.aify", true],
    ["win32", "\\\\wsl.localhost\\ubuntu\\home\\me\\.aify", true],
    ["win32", "//wsl.localhost/ubuntu/home/me/.aify", true],
    ["win32", "c:\\users\\me\\.aify", false],
    ["win32", "\\\\server\\share\\me\\.aify", false],
    ["linux", "/mnt/c/Users/me/.aify", true],
    ["linux", "/mnt/wsl/shared/.aify", true],
    ["linux", "/mnt/d", true],
    ["linux", "/home/me/.aify", false],
    ["linux", "/mnt/data/me/.aify", false],
  ];
  for (const [platform, identity, refused] of rows) {
    assert.equal(Boolean(crossOsHomeReason(identity, { platform })), refused, `${platform} ${identity}`);
  }
});

test("the lock is a named pipe on Windows and an abstract socket on Linux, from sha256 of the identity; elsewhere none", () => {
  const identity = "c:\\users\\me\\.aify";
  const expected = createHash("sha256").update(identity, "utf8").digest("hex");
  assert.equal(roleEndpoint(identity, "win32"), `\\\\.\\pipe\\aify-residents-${expected.slice(0, 16)}`);
  assert.equal(roleEndpoint(identity, "linux"), `\0aify-residents-${expected.slice(0, 16)}`);
  assert.equal(roleEndpoint(identity, "darwin"), null, "macOS is outside this slice: no role, never an approximation");
  assert.equal(residentsPublisherInstance(identity), `residents-${expected.slice(0, 12)}`);
  assert.notEqual(residentsPublisherInstance(identity), RESIDENTS, "the wire key is home-qualified, the local name is not");
});
