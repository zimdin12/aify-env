// The git-directory contents check as rules, with the filesystem injected: what it does when something cannot be
// read, and that following alternates ends. The escapes themselves are in
// the-dashboard-plugin-reads-nothing-nested-out-of-the-grant.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { containmentOf, isRefName, quietContainmentOf } from "../lib/plugins/aify-dashboard/git-dir-contents.mjs";

const plain = { isSymbolicLink: () => false, isDirectory: () => false, nlink: 1 };
const missing = () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };

test("an entry that cannot be read refuses the folder, never passes it", () => {
  // The bug: an unreadable entry skipped, so a git directory nobody could look inside is read anyway.
  const fs = {
    readdir: (dir) => (dir.endsWith("objects") || dir.endsWith("refs") ? [] : ["HEAD"]),
    lstat: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
    readFile: missing,
    realpath: (path) => path,
  };
  assert.equal(containmentOf({ gitDir: "C:/g/.git", commonDir: "C:/g/.git" }, ["c:/g"], "win32", fs),
    "its git directory could not be read whole (EACCES: permission denied)");
});

test("a pack or loose object that is a link refuses the folder, not only a directory", () => {
  // File links need privilege on this host, so the files themselves are injected: a symbolic link to another store's
  // pack, and one to a loose object, each deep inside objects/.
  for (const linked of ["C:/g/.git/objects/pack/pack-1.pack", "C:/g/.git/objects/ab/cdef"]) {
    const tree = { "C:/g/.git": ["objects"], "C:/g/.git/objects": ["ab", "pack"], "C:/g/.git/objects/ab": ["cdef"], "C:/g/.git/objects/pack": ["pack-1.pack"] };
    const fs = {
      readdir: (dir) => tree[dir.replace(/\\/g, "/")] ?? missing(),
      lstat: (path) => {
        const at = path.replace(/\\/g, "/");
        return { isSymbolicLink: () => at === linked, isDirectory: () => at in tree, nlink: 1 };
      },
      readFile: missing,
      realpath: (path) => path,
    };
    const prefix = "its git directory holds a link at ";
    const why = containmentOf({ gitDir: "C:/g/.git", commonDir: "C:/g/.git" }, ["c:/g"], "win32", fs);
    assert.ok(why.startsWith(prefix), why);
    assert.equal(why.slice(prefix.length).replace(/\\/g, "/"), linked);
  }
});

test("anything the fingerprint is about to read that cannot be judged refuses the folder", () => {
  // The bug: a HEAD that cannot be looked at taken as a plain file, and read.
  const refused = () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
  assert.equal(quietContainmentOf({ gitDir: "C:/g/.git", commonDir: "C:/g/.git" }, { lstat: refused, readFile: missing }),
    "its git directory could not be read whole (EACCES: permission denied)");
  const file = { isSymbolicLink: () => false, isDirectory: () => false, nlink: 1 };
  assert.equal(quietContainmentOf({ gitDir: "C:/g/.git", commonDir: "C:/g/.git" }, { lstat: () => file, readFile: () => `${"0".repeat(40)}\n` }),
    "", "a detached HEAD names no ref, and is no reason");
});

test("a ref name is judged by git's own grammar, each rule alone", () => {
  // The bug: a check that splits on "/" and refuses only empty, "." and ".." parts, so a name git would never take
  // still names a path, and on Windows a backslash names one outside the git directory.
  for (const name of ["refs/heads/main", "refs/heads/feature/über", "refs/tags/v1.2.3", "refs/heads/a@b", "refs/remotes/origin/HEAD"]) {
    assert.equal(isRefName(name), true, name);
  }
  const refused = {
    "not under refs/": "heads/main",
    "a backslash": "refs/heads/x\\y",
    "a parent part": "refs/heads/../x",
    "two dots": "refs/heads/a..b",
    "@{": "refs/heads/a@{1}",
    "an empty part": "refs/heads//x",
    "a trailing slash": "refs/heads/x/",
    "a trailing dot": "refs/heads/x.",
    "a part starting with a dot": "refs/heads/.x",
    ".lock": "refs/heads/x.lock",
    "a space": "refs/heads/a b",
    "a control character": "refs/heads/a\tb",
    "DEL": "refs/heads/a\x7fb",
    "~": "refs/heads/a~1", "^": "refs/heads/a^", ":": "refs/heads/a:b", "?": "refs/heads/a?", "*": "refs/heads/a*", "[": "refs/heads/a[",
  };
  for (const [rule, name] of Object.entries(refused)) assert.equal(isRefName(name), false, rule);
});

test("an alternates entry that does not resolve refuses the folder", () => {
  const fs = {
    readdir: () => [],
    lstat: missing,
    readFile: (path) => (path.replace(/\\/g, "/") === "C:/g/.git/objects/info/alternates" ? "C:/gone/objects\n" : missing()),
    realpath: (path) => (path.startsWith("C:/gone") ? missing() : path),
  };
  assert.equal(containmentOf({ gitDir: "C:/g/.git", commonDir: "C:/g/.git" }, ["c:/g"], "win32", fs),
    "its object store borrows objects from C:/gone/objects, which does not resolve to a real path");
});

test("alternates that name each other end, and a store inside is no reason", () => {
  // The bug a follower can have: two stores that name each other followed for ever. The walk is synchronous, so a
  // time limit could not stop it; the fake store gives up after a hundred reads instead, which reads as a refusal.
  const files = { "C:/g/.git/objects": "C:/g/a\n", "C:/g/a": "C:/g/b\n", "C:/g/b": "C:/g/a\n" };
  let reads = 0;
  const fs = {
    readdir: () => [],
    lstat: () => plain,
    readFile: (path) => {
      reads += 1;
      if (reads > 100) throw new Error("followed for ever");
      const store = path.replace(/\\/g, "/").replace(/\/info\/alternates$/, "");
      return store in files ? files[store] : missing();
    },
    realpath: (path) => path.replace(/\\/g, "/"),
  };
  assert.equal(containmentOf({ gitDir: "C:/g/.git", commonDir: "C:/g/.git" }, ["c:/g"], "win32", fs), "");
});
