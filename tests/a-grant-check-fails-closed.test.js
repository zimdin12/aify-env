// The aify-dashboard plugin's grant check, as pure rules: what it does with a place it cannot resolve, and how it
// spells the real roots it compares against. The escapes themselves are in
// the-dashboard-plugin-reads-no-repository-outside-the-grant.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeOf, realPlaces, realRoots } from "../lib/plugins/aify-dashboard/grant-check.mjs";

test("a place that cannot be resolved is refused, never taken as inside", () => {
  // The bug: an unresolvable git directory skipped, so a folder whose real place nobody knows is read anyway.
  const throwing = (path) => {
    if (path.includes("gone")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return path;
  };
  const places = realPlaces({ toplevel: "C:/g/p", gitDir: "C:/g/gone/.git", commonDir: "C:/g/p/.git" }, { realpath: throwing });
  assert.deepEqual(places, [["working tree", "C:/g/p"], ["git directory", null], ["shared git directory", "C:/g/p/.git"]]);
  assert.equal(escapeOf(places, ["c:/g"], "win32"), "its git directory could not be resolved to a real path");
  assert.equal(escapeOf([["working tree", "C:/g/p"], ["git directory", "C:/g/p/.git"]], ["c:/g"], "win32"), "", "all inside: no reason");
  assert.equal(escapeOf([["working tree", "C:/g/p"]], [], "win32"), "its working tree is C:/g/p, outside every granted root", "no roots: nothing is inside");
});

test("real roots are spelled as roots are, and a root that does not resolve is kept as written", () => {
  const realpath = (path) => {
    if (path === "c:/missing") throw new Error("ENOENT");
    return path === "c:/link" ? "D:\\Real\\Root" : path;
  };
  assert.deepEqual(realRoots(["c:/link", "c:/missing", "c:/plain"], { realpath, platform: "win32" }), ["d:/real/root", "c:/missing", "c:/plain"]);
});
