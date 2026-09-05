// The banner has to be able to answer "did my restart take?".
//
// THE INCIDENT, 2026-08-28. A shutdown hang was fixed, the operator restarted, and reported "still
// same old version". The banner said `aify-env 0.6.0` and it had said `aify-env 0.6.0` three days
// earlier, because it renders the `VERSION` file and a bug fix is not a release. So the one indicator
// on the screen was constant across every build, and the only question being asked of it was which
// build this was.
//
// The shape was already right: the banner reads `version` out of the running daemon's own `/health`,
// not off disk, so it describes the running PROCESS rather than the checkout. Only the field was
// wrong. These tests pin the field that moves, the pairing that makes it actionable, and the two ways
// a build identity quietly stops meaning anything -- by never changing, or by changing when nothing
// did.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILD_ID_LENGTH, buildIdentity, sourceFiles } from "../lib/build-identity.mjs";
import { renderDashboard } from "../lib/tui.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const FILES = { "/a.mjs": "one", "/b.mjs": "two" };
const read = (path) => {
  if (!(path in FILES)) throw new Error(`no such file: ${path}`);
  return FILES[path];
};

test("the same bytes always produce the same build", () => {
  // A build that varied per run would report a change on every restart, which is the same as
  // reporting nothing: the operator learns to ignore it.
  assert.equal(buildIdentity(["/a.mjs", "/b.mjs"], read), buildIdentity(["/a.mjs", "/b.mjs"], read));
});

test("the order files are listed in does not change the build", () => {
  // `readdirSync` order is a filesystem property. If it reached the hash, the same code would report
  // a different build on a different machine and comparing two of them would prove nothing.
  assert.equal(buildIdentity(["/a.mjs", "/b.mjs"], read), buildIdentity(["/b.mjs", "/a.mjs"], read));
});

test("one changed byte changes the build", () => {
  // THE WHOLE POINT. Proven against the real files too -- appending one comment line to lib/health.mjs
  // moved 36caa80b to 7196bd24 and restoring it moved it back -- but that run is not repeatable in a
  // suite, so the property is pinned here.
  const before = buildIdentity(["/a.mjs"], read);
  const after = buildIdentity(["/a.mjs"], (path) => (path === "/a.mjs" ? "one!" : read(path)));
  assert.notEqual(before, after);
});

test("renaming a module changes the build even when every byte is the same", () => {
  // The loaded program is different, so the build must be. It also stops two files swapping names
  // from being invisible, which content-only hashing would allow.
  const same = { "/a.mjs": "one" };
  const renamed = { "/z.mjs": "one" };
  assert.notEqual(
    buildIdentity(Object.keys(same), (p) => same[p]),
    buildIdentity(Object.keys(renamed), (p) => renamed[p]),
  );
});

test("a name and its content cannot be confused for a shorter name and a longer content", () => {
  // Concatenating name and bytes without a separator lets ("ab", "c") and ("a", "bc") hash the same.
  // Both are reachable: module names and their first bytes are both ordinary text.
  const one = { ab: "c" };
  const two = { a: "bc" };
  assert.notEqual(
    buildIdentity(Object.keys(one), (p) => one[p]),
    buildIdentity(Object.keys(two), (p) => two[p]),
  );
});

test("the same code installed in two places reports one build", () => {
  // The absolute path differs per install; a hash over it would make every install look different and
  // the banner-vs-disk comparison would never agree. The caller supplies the relative name.
  const relative = (root) => (path) => path.slice(root.length);
  const atOne = buildIdentity(["/opt/x/lib/a.mjs"], () => "one", relative("/opt/x"));
  const atTwo = buildIdentity(["/home/y/lib/a.mjs"], () => "one", relative("/home/y"));
  assert.equal(atOne, atTwo);
});

test("the build is short enough to compare by eye and long enough to mean something", () => {
  const id = buildIdentity(["/a.mjs"], read);
  assert.equal(id.length, BUILD_ID_LENGTH);
  assert.match(id, /^[0-9a-f]+$/, "a build somebody reads off a screen must be plain hex");
});

/** A dirent stand-in, so a fake tree can say what is a directory without a second stat. */
const file = (name) => ({ name, isDirectory: () => false });
const dir = (name) => ({ name, isDirectory: () => true });

test("the file list is DERIVED from the tree, so a new module counts", () => {
  // A hardcoded list would be a second place to remember. A module added and forgotten there would
  // be LOADED by the daemon and absent from its build, so changing it would report no change.
  const tree = {
    "/pkg/lib": [file("a.mjs"), file("b.js"), file("notes.md"), file("c.mjs")],
    "/pkg/bin": [file("aify-env.mjs")],
  };
  const { files: listed } = sourceFiles("/pkg", (d) => tree[d] || [], (...parts) => parts.join("/"));
  assert.deepEqual(listed.sort(), [
    "/pkg/bin/aify-env.mjs", "/pkg/lib/a.mjs", "/pkg/lib/b.js", "/pkg/lib/c.mjs",
  ]);
});

test("IT RECURSES, because the failure it warns about happened one directory down", () => {
  // MEASURED 2026-09-03. This listed `lib/*` non-recursively, so the whole of `lib/plugins/` -- the
  // aify-comms plugin, its API client, its claim pass and its terminal-control pass -- was invisible
  // to the build id. FOUR commits changed the running program and the number did not move once.
  //
  // The operator restarts and compares that number to decide whether the restart took, so the one
  // instrument on the critical path was answering about a subset of the program. This module's own
  // docstring predicted it in those words, which is why the rule is now "walk", not "walk and also
  // remember these".
  const tree = {
    "/pkg/lib": [file("a.mjs"), dir("plugins")],
    "/pkg/lib/plugins": [dir("aify-comms"), file("index.mjs")],
    "/pkg/lib/plugins/aify-comms": [file("api.mjs"), file("claim.mjs")],
    "/pkg/bin": [file("aify-env.mjs")],
  };
  const { files: listed } = sourceFiles("/pkg", (d) => tree[d] || [], (...parts) => parts.join("/"));
  assert.ok(listed.includes("/pkg/lib/plugins/aify-comms/api.mjs"), "a plugin module is part of the program");
  assert.ok(listed.includes("/pkg/lib/plugins/index.mjs"));
  assert.equal(listed.length, 5);
});

test("EVERY bin entry point counts, not just the daemon", () => {
  // The doctor, the TUI and the credential command are each code an operator runs, and each is a
  // thing they would want to know the version of. Naming one of them was the same class of omission
  // as not recursing: a rule somebody has to remember when they add a file.
  const tree = {
    "/pkg/lib": [],
    "/pkg/bin": [file("aify-env.mjs"), file("aify-env-doctor.mjs"), file("aify-env-tui.mjs")],
  };
  const { files: listed } = sourceFiles("/pkg", (d) => tree[d] || [], (...parts) => parts.join("/"));
  assert.equal(listed.length, 3);
});

test("node_modules is NOT part of this program's identity", () => {
  // A dependency tree is thousands of files and changes on an unrelated schedule; hashing it would
  // make the build id move for reasons that have nothing to do with the code being restarted.
  const tree = {
    "/pkg/lib": [file("a.mjs"), dir("node_modules")],
    "/pkg/lib/node_modules": [file("huge.js")],
    "/pkg/bin": [],
  };
  const { files: listed } = sourceFiles("/pkg", (d) => tree[d] || [], (...parts) => parts.join("/"));
  assert.deepEqual(listed, ["/pkg/lib/a.mjs"]);
});

test("a directory that cannot be read contributes nothing, AND THE WALK SAYS SO", () => {
  // A build id that cannot be computed would take the daemon down at BOOT, which is a far worse
  // failure than one computed over slightly less than everything -- so the walk still returns what
  // it found. But it must also REPORT that it was incomplete: a hash over a subset is a well-formed
  // digest that DIFFERS from the real one, so the service reads `stale`, the badge says restart, and
  // restarting reaps that host's managed workers. Returning the subset silently was the defect.
  const scan = sourceFiles("/pkg", (d) => {
    if (d === "/pkg/lib") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return [file("aify-env.mjs")];
  }, (...parts) => parts.join("/"));
  assert.deepEqual(scan.files, ["/pkg/bin/aify-env.mjs"]);
  assert.equal(scan.complete, false, "an unreadable directory was reported as a complete answer");
});

test("an ABSENT directory is complete, because a smaller program is not an unmeasured one", () => {
  // `readdirSync` throws ENOENT for a directory that is not there and EACCES for one it may not
  // read. Conflating them would make every package without a `bin/` unidentifiable for ever.
  const scan = sourceFiles("/pkg", (d) => {
    if (d === "/pkg/bin") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return [file("a.mjs")];
  }, (...parts) => parts.join("/"));
  assert.deepEqual(scan.files, ["/pkg/lib/a.mjs"]);
  assert.equal(scan.complete, true, "a missing directory was treated as a failure to measure");
});

test("an empty tree yields an empty list rather than an invented entry", () => {
  // It used to return `bin/aify-env.mjs` unconditionally, whether or not it was there. A path that
  // is hashed without being read is a build id that describes a file that may not exist.
  assert.deepEqual(sourceFiles("/pkg", () => [], (...parts) => parts.join("/")).files, []);
});

test("/health reports the build, so the banner describes the PROCESS and not the disk", async () => {
  const response = await handleRequest(
    { method: "GET", path: "/health" },
    { runner: { list: () => [], exits: () => [] }, readFile: () => "", version: "0.6.0", build: "deadbeef" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.build, "deadbeef");
  assert.equal(response.body.version, "0.6.0", "the release version must not be replaced by the build");
});

test("a daemon that reports no build still answers /health", async () => {
  // Absence is not an error. An older daemon has no build to give and must not 500 for it.
  const response = await handleRequest(
    { method: "GET", path: "/health" },
    { runner: { list: () => [], exits: () => [] }, readFile: () => "", version: "0.6.0" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.build, "");
});

test("the banner shows the build beside the version", () => {
  const [line] = renderDashboard({
    version: "0.6.0", build: "36caa80b", endpoint: "http://127.0.0.1:8802",
    terminals: { available: true }, services: [], processes: [], traffic: { requests: 0, bytesOut: 0 },
  }, { columns: 120 });
  assert.match(line, /aify-env 0\.6\.0/);
  assert.match(line, /36caa80b/, "the banner cannot answer 'did my restart take?' without the build");
});

test("a missing build renders nothing rather than a placeholder", () => {
  // "?" in a field somebody is about to compare by eye is worse than a shorter line: two daemons both
  // showing "?" look equal, which is the wrong answer with confidence.
  for (const snapshot of [{ build: "" }, { build: "   " }, {}]) {
    const [line] = renderDashboard({
      version: "0.6.0", endpoint: "http://127.0.0.1:8802", terminals: { available: true },
      services: [], processes: [], traffic: { requests: 0, bytesOut: 0 }, ...snapshot,
    }, { columns: 120 });
    assert.match(line, /aify-env 0\.6\.0/);
    assert.ok(!line.includes("build"), `rendered a build field with nothing in it: ${line}`);
  }
});
