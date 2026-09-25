// `aify-env herdr` finds Herdr in the places its installer puts it, as `herdr-aify` does.
//
// THE DEFECT (v0.7 scan, F19). aify-env's detector checked PATH and `%LOCALAPPDATA%/Programs/Herdr/bin`
// only. aify-wrapper's checks `HERDR_BIN_PATH`, Herdr's standalone package under `HERDR_HOME`, then
// `HERDR_INSTALL_DIR`, then PATH -- and records that at an ordinary Windows prompt Herdr is usually
// NOT on PATH. So `aify-env herdr` could fail to find a Herdr that `herdr-aify` found. The order and
// the places below are aify-wrapper's `lib/herdr-binary.mjs`, read from Herdr v0.9.0's installers.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { detectHerdr, herdrCandidates } from "../lib/herdr.mjs";

/** A filesystem that holds exactly `files`, with `releases` under the standalone package. */
function fakeFs(files, releases = []) {
  const set = new Set(files.map((f) => path.normalize(f)));
  return {
    exists: (candidate) => set.has(path.normalize(candidate)),
    readdir: () => releases,
  };
}

const HOME = path.join("C:", "Users", "op");
const win = (env, fs) => detectHerdr(env, { platform: "win32", home: HOME, ...fs });

test("HERDR_BIN_PATH is authoritative -- it names the binary that opened this pane", () => {
  const bin = path.join("D:", "tools", "herdr.exe");
  assert.equal(win({ HERDR_BIN_PATH: bin, PATH: "" }, fakeFs([])), bin);
});

test("the standalone package under HERDR_HOME, or ~/.herdr, is found without PATH", () => {
  const current = path.join(HOME, ".herdr", "packages", "standalone", "current", "herdr.exe");
  assert.equal(win({ PATH: "" }, fakeFs([current])), current);
  const custom = path.join("E:", "h", "packages", "standalone", "current", "herdr.exe");
  assert.equal(win({ PATH: "", HERDR_HOME: path.join("E:", "h") }, fakeFs([custom])), custom);
});

test("a release directory is used when the `current` link is missing", () => {
  const release = path.join(HOME, ".herdr", "packages", "standalone", "releases", "0.9.0", "herdr.exe");
  assert.equal(win({ PATH: "" }, fakeFs([release], ["0.8.0", "0.9.0"])), release);
});

test("HERDR_INSTALL_DIR replaces the default bin directory", () => {
  const bin = path.join("F:", "bin", "herdr.exe");
  assert.equal(win({ PATH: "", HERDR_INSTALL_DIR: path.join("F:", "bin") }, fakeFs([bin])), bin);
});

test("CONTROL: the default Windows bin and PATH still work, and nothing found is null", () => {
  const local = path.join("L:", "Programs", "Herdr", "bin", "herdr.exe");
  assert.equal(win({ PATH: "", LOCALAPPDATA: "L:" }, fakeFs([local])), local);
  const onPath = path.join("P:", "x", "herdr.exe");
  assert.equal(win({ PATH: path.join("P:", "x") }, fakeFs([onPath])), onPath);
  assert.equal(win({ PATH: "" }, fakeFs([])), null);
});

test("a refusal can say where it looked", () => {
  const tried = herdrCandidates({ PATH: "", LOCALAPPDATA: "L:" }, { platform: "win32", home: HOME, readdir: () => [] });
  assert.ok(tried.some((p) => p.includes(path.join(".herdr", "packages", "standalone", "current"))));
  assert.ok(tried.some((p) => p.includes(path.join("Programs", "Herdr", "bin"))));
});
