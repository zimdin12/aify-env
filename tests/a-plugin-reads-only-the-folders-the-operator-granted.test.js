// `watchRoots` is the operator's grant of folders a plugin may read (lib/watch-roots.mjs). It fails closed: whatever
// is missing or malformed grants nothing, and containment is by whole path segments.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { grantedRoots, readGrantedRoots, readWatchRoots, watchRootsFrom, withinWatchRoots } from "../lib/watch-roots.mjs";

const grant = (roots) => JSON.stringify({ version: 1, transport: { localSocket: true }, watchRoots: roots });

test("A GRANT IS READ, normalized to one spelling per folder", () => {
  const read = watchRootsFrom(grant(["C:\\Docker\\", "c:/docker", "D:/Work/Repo"]), "win32");
  assert.deepEqual(read, { roots: ["c:/docker", "d:/work/repo"], problem: "" });
  assert.deepEqual(watchRootsFrom(grant(["/home/me/src/"]), "linux"), { roots: ["/home/me/src"], problem: "" });
});

test("NOTHING IS GRANTED by a missing, empty, unparseable or malformed list; only a malformed one is a fault", () => {
  for (const [text, label, fault] of [
    [null, "no file", false], ["", "empty file", false], [JSON.stringify({ version: 1 }), "no key", false],
    [grant([]), "an empty list", false], ["{not json", "not JSON", true], [grant("C:/docker"), "a string, not a list", true],
  ]) {
    const read = watchRootsFrom(text, "win32");
    assert.deepEqual(read.roots, [], label);
    assert.equal(Boolean(read.problem), fault, `${label}: ${read.problem}`);
  }
});

const reading = (id, workspace, problems = []) => ({ id, problems, agent: { id, workspace } });  // an invalid one keeps a stale body here, so only its problems may stop the grant
const none = { roots: [], problem: "" };

test("A DEFINED AGENT'S WORKSPACE IS GRANTED, beside the explicit list", () => {
  const granted = grantedRoots({ roots: ["c:/extra"], problem: "" },
    [reading("a", "C:/Docker/aify-project-graph"), reading("b", "c:/docker/aify-project-graph/")], "win32");
  assert.deepEqual(granted, { roots: ["c:/extra", "c:/docker/aify-project-graph"], problems: [] });
});

test("AN INVALID DEFINITION GRANTS NOTHING, and a relative workspace is named, not granted", () => {
  const granted = grantedRoots(none, [reading("bad", "C:/secret", ["agent.model: type"]), reading("rel", "work/x")], "win32");
  assert.deepEqual(granted.roots, []);
  assert.deepEqual(granted.problems, ['agent rel: workspace "work/x" is not an absolute path']);
});

test("A MALFORMED LIST VOIDS ONLY ITSELF: the workspaces still grant, and the fault is reported", () => {
  const listed = watchRootsFrom(grant(["C:/docker", "relative"]), "win32");
  const granted = grantedRoots(listed, [reading("a", "D:/work/a")], "win32");
  assert.deepEqual(granted.roots, ["d:/work/a"]);
  assert.match(granted.problems[0], /not an absolute path/);
});

test("UNREADABLE DEFINITIONS GRANT NO WORKSPACE, and with nothing at all the reason is stated", async () => {
  const unreadable = await readGrantedRoots({ definitions: { list: async () => { throw new Error("locked"); } }, readFile: () => "", platform: "win32" });
  assert.deepEqual(unreadable, { roots: [], problems: ["agent definitions are unreadable, so no workspace is granted"] });
  const empty = await readGrantedRoots({ definitions: { list: async () => ({ definitions: [] }) }, readFile: () => "", platform: "win32" });
  assert.deepEqual(empty, { roots: [], problems: ["nothing is granted: no agent is defined and watchRoots is empty"] });
  const store = { list: async () => ({ definitions: [reading("a", "C:/docker/a")] }) };
  assert.deepEqual((await readGrantedRoots({ definitions: store, readFile: () => "", platform: "win32" })).roots, ["c:/docker/a"],
    "CONTROL: a readable store grants its workspace");
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
    assert.deepEqual(readWatchRoots({ home, env: {} }), { roots: [], problem: "" }, "no file is no list, and no fault");
    fs.mkdirSync(path.join(home, ".aify"));
    fs.writeFileSync(path.join(home, ".aify", "config.json"), grant(["C:/docker"]));
    assert.deepEqual(readWatchRoots({ home, env: {}, platform: "win32" }).roots, ["c:/docker"]);
    for (const code of ["EACCES", "EBUSY", "EISDIR"]) {
      const throwing = () => { throw Object.assign(new Error(code), { code }); };
      const read = readWatchRoots({ home, env: {}, readFile: throwing, platform: "win32" });
      assert.deepEqual(read.roots, [], `${code}: nothing granted`);
      assert.match(read.problem, new RegExp(`unreadable \\(${code}\\)`), `${code}: and it says so, never reading as no file`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
