import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardApi } from "../lib/plugins/aify-dashboard/dashboard-api.mjs";
import { HeadWatcher } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { isWslReporter, platformOfNamespace } from "../lib/plugins/aify-dashboard/locations.mjs";
import { isWindowsMountPath, readWslLocation, wslNamespace } from "../lib/plugins/aify-dashboard/wsl-location.mjs";

const WSL = { distroId: "Fixture-Distro", driveMounts: [{ drive: "C", mountPoint: "/mnt/my drive" }] };

function factsWith(id, mounts) {
  return readWslLocation({ readFile(path) {
    if (path === "/etc/machine-id") return id;
    if (path === "/proc/mounts" && mounts !== undefined) return mounts;
    throw new Error("missing fact");
  } });
}

test("WSL uses the local distro identity and verified Windows drive mounts", () => {
  const mounts = String.raw`C:\134 /mnt/my\040drive 9p rw,aname=drvfs;path=C:\;uid=1000 0 0`;
  assert.deepEqual(factsWith(" Fixture-Distro\n", mounts), WSL);
  assert.equal(wslNamespace(WSL.distroId), "wsl:Fixture-Distro");
  assert.equal(isWslReporter("wsl:host"), true);
  assert.equal(isWslReporter("linux:host"), false);
  assert.equal(platformOfNamespace(wslNamespace(WSL.distroId)), "linux");
  assert.equal(platformOfNamespace("wsl:"), null);
  assert.equal(platformOfNamespace("posix"), null);
  assert.equal(isWindowsMountPath("/mnt/my drive/repo", WSL), true);
  assert.equal(isWindowsMountPath("/mnt/my drive-other/repo", WSL), false);
  assert.equal(factsWith("", mounts), null, "an empty identity must not enable a shared namespace");
  assert.equal(factsWith("bad:id:value", mounts), null, "an invalid identity must not enable a namespace");
  assert.equal(factsWith("Fixture-Distro"), null, "missing mounts are unknown, not an empty drive list");
});

const watchList = (rows) => ({ hostKey: "h", projects: rows.map(([id, fsNamespace, path]) => ({ projectId: id, name: id, root: { fsNamespace, path } })) });

function watcherWith(wsl, rows) {
  const mustNotRead = () => assert.fail("a refused folder reached filesystem work");
  return new HeadWatcher({ machineId: "wsl:h", wsl, reporter: "fixture", api: { watchList: async () => watchList(rows) },
    git: { gitDirs: mustNotRead }, realpath: mustNotRead, binding: mustNotRead,
    watchRoots: async () => ({ roots: ["/home/Work"], problems: [] }) });
}

test("missing WSL location facts are named even for an empty watch list", async () => {
  const watcher = watcherWith(null, []);
  await watcher.tick();
  assert.deepEqual(watcher.watched(), []);
  assert.match(watcher.state().problems.join("\n"), /WSL watch list refused.*\/etc\/machine-id/);
});

test("foreign or ungranted watch-list rows never reach filesystem work", async () => {
  const watcher = watcherWith(WSL, [
    ["windows", "windows", "C:/Work/fixture"], ["linux", "linux", "/home/Work/native"],
    ["other", "wsl:Other-Distro", "/home/Work/other"],
    ["sibling", "wsl:Fixture-Distro", "/home/Workspace/sibling"],
  ]);
  const touched = [];
  const probe = new HeadWatcher({ machineId: "wsl:h", wsl: WSL, reporter: "fixture",
    api: { watchList: async () => watchList([["other", "wsl:Other-Distro", "/home/Work/other"]]) },
    git: { gitDirs: path => touched.push(path) }, realpath: path => { touched.push(path); return path; },
    watchRoots: async () => ({ roots: ["/home/Work"], problems: [] }) });
  await watcher.tick();
  await probe.tick();
  assert.deepEqual(touched, [], "wrong namespace must be refused before any filesystem work");
  assert.deepEqual(watcher.watched(), []);
  assert.equal(watcher.state().refused, 4);
  assert.match(watcher.state().problems.join("\n"), /outside every granted folder/);
  assert.doesNotMatch(watcher.state().problems.join("\n"), /reached filesystem work/);
});

async function reportBodies(wsl) {
  const bodies = [];
  const api = new DashboardApi({ endpoint: "http://127.0.0.1:9", wsl, credential: async () => "fixture-only",
    fetch: async (url, init) => {
      bodies.push([new URL(url).pathname, JSON.parse(init.body)]);
      return Response.json({ ok: true });
    } });
  const data = { machineId: wsl ? "wsl:host" : "linux:host", path: "/home/work", reporter: "reporter", head: "head", cursorRevision: 1 };
  await api.reportHead(data);
  await api.openRange(data);
  await api.resync(data);
  await api.sendFileList({ machineId: data.machineId, worktree: { raw: data.path, canonical: data.path }, head: data.head });
  await api.sendBatch("range-id", { reporter: data.reporter, batchIndex: 0, commits: [], hasMore: false });
  return bodies;
}

test("only worktree reports carry WSL facts; a batch stays bound by range id", async () => {
  const paths = ["/reports/head", "/instances/reporter/commit-ranges", "/instances/reporter/resync", "/reports/file-list", "/commit-ranges/range-id/batches"];
  const withWsl = await reportBodies(WSL);
  const withoutWsl = await reportBodies(null);
  assert.deepEqual(withWsl.map(([path]) => path), paths);
  assert.deepEqual(withoutWsl.map(([path]) => path), paths);
  assert.deepEqual(withWsl.slice(0, 4).map(([, body]) => body.wsl), Array(4).fill(WSL));
  assert.ok(withoutWsl.every(([, body]) => !("wsl" in body)), "old report shapes must be byte-compatible off WSL");
  assert.deepEqual(withWsl[4], withoutWsl[4], "the range batch has no placement facts and its shape is unchanged");
});
