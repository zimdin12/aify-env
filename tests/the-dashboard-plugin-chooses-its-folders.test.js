// Which listed folders the aify-dashboard plugin may read, and the host key it asks under.
//
// EVERY REFUSAL IS ASSERTED BESIDE A FOLDER THAT IS ACCEPTED, so a check that refused everything would
// fail as surely as one that refused nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { machineIdFor } from "../lib/advertise.mjs";
import { watchRootsFrom } from "../lib/watch-roots.mjs";
import {
  MAX_LOCATIONS, hostKeyOf, namespaceOf, parseWatchList, selectLocations,
} from "../lib/plugins/aify-dashboard/locations.mjs";

const item = (path, namespace = "windows") => ({ projectId: `p-${path}`, name: path, namespace, path });
const granted = (...paths) => watchRootsFrom(JSON.stringify({ watchRoots: paths }), "win32").roots;

test("a mixed-case hostname still asks for a lowercase host key", () => {
  // The bug: the dashboard answers a mixed-case key with 400, so this host would refresh every five
  // minutes, be refused every time, and watch nothing.
  assert.equal(hostKeyOf(machineIdFor({ platform: "win32", hostname: "StevenZ-L" })), "stevenz-l");
  // And without machineIdFor's help, in case a caller hands over a machine id it did not make.
  assert.equal(hostKeyOf("win32:StevenZ-L"), "stevenz-l");
  assert.equal(hostKeyOf("no-colon"), "");
});

test("the reporter reads only its own filesystem namespace and never guesses a WSL identity", () => {
  assert.equal(namespaceOf("win32:host"), "windows");
  assert.equal(namespaceOf("linux:host"), "linux");
  assert.equal(namespaceOf("darwin:host"), null);
  assert.equal(namespaceOf("wsl:host"), null);
  assert.equal(namespaceOf("wsl:host", { distroId: "bad:id" }), null);
  assert.equal(namespaceOf("wsl:host", { distroId: "Distro-Own" }), "wsl:Distro-Own");
});

test("a WSL reporter accepts only its own granted native folder", () => {
  const wsl = { distroId: "Distro-Own", driveMounts: [{ mountPoint: "/mnt/c", drive: "C" }] };
  const own = "wsl:Distro-Own";
  const { watch, refused } = selectLocations([
    item("/root/Work/repo", own),
    item("C:/Work/repo", "windows"),
    item("/root/Work/native", "linux"),
    item("/root/Work/foreign", "wsl:Distro-Other"),
    item("C:/Work/mislabeled", own),
    item("/mnt/c/Work/mislabeled", own),
    item("/root/Workspace/sibling", own),
    item("/root/work/wrong-case", own),
  ], { namespace: own, roots: ["/root/Work", "/mnt/c/Work"], wsl });
  assert.deepEqual(watch.map(row => row.path), ["/root/Work/repo"]);
  assert.deepEqual(refused.map(row => row.path), ["C:/Work/repo", "/root/Work/native", "/root/Work/foreign",
    "C:/Work/mislabeled", "/mnt/c/Work/mislabeled", "/root/Workspace/sibling", "/root/work/wrong-case"]);
  assert.match(refused[2].reason, /wsl:Distro-Other namespace/);
  assert.match(refused[4].reason, /Windows drive mount/);
  assert.match(refused[5].reason, /outside every granted folder/);
});

test("a granted root covers its own folders by whole segments, and nothing beside or above it", () => {
  // The bug: a prefix match, under which granting C:/docker also grants C:/dockerx, or a path that
  // climbs out through "..". The roots are made by aify-env's own reader, as they arrive in use.
  const { roots, problem } = watchRootsFrom(JSON.stringify({ watchRoots: ["C:\\Docker"] }), "win32");
  assert.equal(problem, "");
  const listed = ["C:/docker/a", "c:\\Docker\\b", "C:/docker", "C:/dockerx/c", "C:/docker/../secrets"].map((path) => item(path));
  const { watch, refused } = selectLocations(listed, { namespace: "windows", roots });
  assert.deepEqual(watch.map((w) => w.path), ["C:/docker/a", "c:\\Docker\\b", "C:/docker"]);
  assert.deepEqual(refused.map((r) => r.path), ["C:/dockerx/c", "C:/docker/../secrets"]);
});

test("a folder outside every root, or in another namespace, is refused with its reason; the rest are watched", () => {
  const { watch, refused } = selectLocations(
    [item("C:/docker/a"), item("C:/dockerx/b"), item("D:/other"), item("/home/me/c", "wsl:Ubuntu")],
    { namespace: "windows", roots: granted("C:/docker") },
  );
  assert.deepEqual(watch.map((w) => w.path), ["C:/docker/a"]);
  assert.deepEqual(refused.map((r) => r.path), ["C:/dockerx/b", "D:/other", "/home/me/c"]);
  assert.match(refused[0].reason, /outside every granted folder/);
  assert.match(refused[2].reason, /wsl:Ubuntu namespace/);
});

test("no granted root reads nothing, and says what to add", () => {
  // The bug this catches: defaulting to some folder when the operator granted none.
  const { watch, refused } = selectLocations([item("C:/docker/a")], { namespace: "windows", roots: [] });
  assert.deepEqual(watch, []);
  assert.match(refused[0].reason, /"watchRoots"/);
});

test("past the limit, the rest are refused by name rather than dropped", () => {
  const many = Array.from({ length: MAX_LOCATIONS + 1 }, (_, i) => item(`C:/docker/r${i}`));
  const { watch, refused } = selectLocations(many, { namespace: "windows", roots: granted("C:/docker") });
  assert.equal(watch.length, MAX_LOCATIONS);
  assert.deepEqual(refused.map((r) => r.path), [`C:/docker/r${MAX_LOCATIONS}`]);
  assert.match(refused[0].reason, /more than 200/);
});

test("a malformed or misaddressed watch list is a failure, never an empty list", () => {
  const good = { hostKey: "h", projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows", path: "C:/x" } }] };
  assert.deepEqual(parseWatchList(good, "h"), { ok: true, items: [{ projectId: "p", name: "n", namespace: "windows", path: "C:/x" }] });
  assert.equal(parseWatchList({ hostKey: "other", projects: [] }, "h").ok, false);
  assert.equal(parseWatchList({ hostKey: "h" }, "h").ok, false);
  assert.equal(parseWatchList(null, "h").ok, false);
  const noPath = { hostKey: "h", projects: [{ projectId: "p", name: "n", root: { fsNamespace: "windows" } }] };
  assert.match(parseWatchList(noPath, "h").problem, /entry 0/);
});
