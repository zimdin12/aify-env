// `watchRoots` is the operator's grant of folders a plugin may read (lib/watch-roots.mjs). It fails closed: whatever
// is missing or malformed grants nothing, and containment is by whole path segments.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readWatchRoots, watchRootsFrom, withinWatchRoots } from "../lib/watch-roots.mjs";

const grant = (roots) => JSON.stringify({ version: 1, transport: { localSocket: true }, watchRoots: roots });

test("A GRANT IS READ, normalized to one spelling per folder", () => {
  const read = watchRootsFrom(grant(["C:\\Docker\\", "c:/docker", "D:/Work/Repo"]), "win32");
  assert.deepEqual(read, { roots: ["c:/docker", "d:/work/repo"], problem: "" });
  assert.deepEqual(watchRootsFrom(grant(["/home/me/src/"]), "linux"), { roots: ["/home/me/src"], problem: "" });
});

test("NOTHING IS GRANTED by a missing, empty, unparseable or malformed list", () => {
  for (const [text, label] of [
    [null, "no file"], ["", "empty file"], ["{not json", "not JSON"],
    [JSON.stringify({ version: 1 }), "no key"], [grant("C:/docker"), "a string, not a list"], [grant([]), "an empty list"],
  ]) {
    const read = watchRootsFrom(text, "win32");
    assert.deepEqual(read.roots, [], label);
    assert.ok(read.problem, `${label}: the reason is stated`);
  }
});

test("ONE INVALID ENTRY REFUSES THE WHOLE LIST rather than granting the rest", () => {
  for (const bad of ["docker", "./docker", "/docker", "\\\\server\\share", 7, ""]) {
    const read = watchRootsFrom(grant(["C:/docker", bad]), "win32");
    assert.deepEqual(read.roots, [], `entry ${JSON.stringify(bad)}`);
    assert.match(read.problem, /not an absolute path/);
  }
  assert.deepEqual(watchRootsFrom(grant(["relative/dir"]), "linux").roots, []);
});

test("CONTAINMENT IS BY WHOLE SEGMENTS, case-folded on win32 only", () => {
  const win = ["c:/docker"];
  assert.equal(withinWatchRoots("C:/Docker/aify-project-graph", win, "win32"), true);
  assert.equal(withinWatchRoots("C:\\docker", win, "win32"), true, "the root itself");
  assert.equal(withinWatchRoots("C:/dockerx/repo", win, "win32"), false, "a sibling that shares a prefix");
  assert.equal(withinWatchRoots("C:/docker/../windows", win, "win32"), false, "a parent reached through ..");
  assert.equal(withinWatchRoots("D:/docker/x", win, "win32"), false, "another drive");
  assert.equal(withinWatchRoots("relative/x", win, "win32"), false);
  assert.equal(withinWatchRoots("/home/me/src/x", ["/home/me/src"], "linux"), true);
  assert.equal(withinWatchRoots("/home/me/SRC/x", ["/home/me/src"], "linux"), false, "linux paths keep their case");
  assert.equal(withinWatchRoots("C:/docker/x", [], "win32"), false, "CONTROL: no roots, nothing is within");
});

test("READ FROM ~/.aify/config.json, and an unreadable file grants nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-watch-roots-"));
  try {
    assert.deepEqual(readWatchRoots({ home, env: {} }).roots, [], "no file");
    fs.mkdirSync(path.join(home, ".aify"));
    fs.writeFileSync(path.join(home, ".aify", "config.json"), grant(["C:/docker"]));
    assert.deepEqual(readWatchRoots({ home, env: {}, platform: "win32" }).roots, ["c:/docker"]);
    const throwing = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    assert.deepEqual(readWatchRoots({ home, env: {}, readFile: throwing, platform: "win32" }).roots, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
