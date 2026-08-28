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

test("the file list is DERIVED from the directory, so a new module counts", () => {
  // A hardcoded list would be a second place to remember. A module added to lib/ and forgotten there
  // would be LOADED by the daemon and absent from its build, so changing it would report no change --
  // this module's own failure mode, one directory down.
  const listed = sourceFiles("/pkg", (dir) => {
    assert.equal(dir, "/pkg/lib");
    return ["a.mjs", "b.js", "notes.md", "c.mjs"];
  }, (...parts) => parts.join("/"));
  assert.deepEqual(listed, ["/pkg/bin/aify-env.mjs", "/pkg/lib/a.mjs", "/pkg/lib/b.js", "/pkg/lib/c.mjs"]);
});

test("the entry point counts as source", () => {
  // It holds the wiring, the routes' dependency bag and the signal handlers. A change there is a
  // change to the program even when every module under lib/ is untouched -- and the shutdown fix that
  // started all this was one import away from being exactly that.
  const listed = sourceFiles("/pkg", () => [], (...parts) => parts.join("/"));
  assert.deepEqual(listed, ["/pkg/bin/aify-env.mjs"]);
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
