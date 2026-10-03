// The code provider's client runs only in a folder the grant reaches at the moment it starts: the real folder it runs
// in, not only the listed path that led there.
//
// The bug (review of 8e7a638, P2-G1): the runner judged the listed path against the grant read just before starting,
// and then started the client in the real folder the watcher's look had judged under the grant of its last refresh.
// A listed junction kept/hop leading to a sibling folder, admitted under a broad grant, still had the client started
// in the sibling after the grant was narrowed to kept: the listed path was still inside, and nobody asked about the
// real one. Real junctions; the watcher's git, the dashboard and the client are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HeadWatcher } from "../lib/plugins/aify-dashboard/head-watcher.mjs";
import { ProviderRunner } from "../lib/plugins/aify-dashboard/provider-runner.mjs";
import { watchRootsFrom } from "../lib/watch-roots.mjs";

const onlyWindows = process.platform !== "win32" && "junctions are Windows-only";
const slashed = (path) => path.replace(/\\/g, "/");
const rootsOf = (...paths) => watchRootsFrom(JSON.stringify({ watchRoots: paths }), "win32").roots;
const OK = { code: 0, signal: null, timedOut: false, stopped: false, error: "" };

/** A watcher over one listed folder, a runner over the watcher's offer, and a grant either can be handed. */
function scene(listed, grant) {
  const now = { roots: grant };
  const watcher = new HeadWatcher({
    api: {
      watchList: async (hostKey) => ({ hostKey, projects: [{ projectId: "p1", name: "n", root: { fsNamespace: "windows", path: slashed(listed) } }] }),
      reportHead: async ({ head }) => ({ ok: true, ackedHead: head, cursorRevision: 1 }),
    },
    git: { gitDirs: async () => ({ toplevel: listed, gitDir: join(listed, ".git"), commonDir: join(listed, ".git") }), head: async () => "a".repeat(40) },
    watchRoots: async () => ({ roots: now.roots, problems: [] }),
    machineId: "win32:h",
    reporter: "r",
    binding: () => "bound",
    fingerprint: () => "HEAD=ref: refs/heads/main",
    contents: { quiet: () => "", nested: () => "" },
  });
  const runs = [];
  const runner = new ProviderRunner({
    api: { providerPending: async (hostKey) => ({ hostKey, projects: [{ projectId: "p1", queued: 1 }] }) },
    credential: async () => "k".repeat(32),
    folders: () => watcher.watched(),
    watchRoots: async () => ({ roots: now.roots, problems: [] }),
    config: () => ({ config: { providerCheckout: "C:/checkout" }, problem: "" }),
    exists: () => true,
    endpoint: "http://127.0.0.1:9",
    hostKey: "h",
    reporter: "r",
    parentEnv: {},
    nodePath: "C:/node.exe",
    run: async (args) => { runs.push(args.cwd); return OK; },
  });
  return { watcher, runner, runs, now, problems: () => runner.state().problems.join("\n") };
}

/** root/kept/hop, a junction to root/target, which holds a .git. */
function layout() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aify-provider-grant-")));
  const kept = join(root, "kept");
  const target = join(root, "target");
  mkdirSync(kept);
  mkdirSync(join(target, ".git"), { recursive: true });
  const hop = join(kept, "hop");
  symlinkSync(target, hop, "junction");
  return { root, kept, target, hop };
}

test("a grant narrowed after a look leaves the listed alias inside and its real folder outside: no client runs", { skip: onlyWindows }, async () => {
  const l = layout();
  const s = scene(l.hop, rootsOf(l.root));
  await s.watcher.tick();
  assert.equal(s.watcher.watched().length, 1, "offered under the broad grant");
  s.now.roots = rootsOf(l.kept);
  await s.runner.pass();
  assert.deepEqual(s.runs, [], "not started in the folder the grant no longer reaches");
  assert.match(s.problems(), /project p1 has 1 code-provider call\(s\) queued, and no watched, granted folder here/);
});

test("the grant unchanged, the client runs in the real folder; a granted root that is itself a junction still serves", { skip: onlyWindows }, async () => {
  // The two the fix must keep: an unchanged grant, and a grant written as an alias of the folder it grants.
  const l = layout();
  const broad = scene(l.hop, rootsOf(l.root));
  await broad.watcher.tick();
  await broad.runner.pass();
  assert.deepEqual(broad.runs, [l.target]);

  const alias = join(l.root, "alias-of-target");
  symlinkSync(l.target, alias, "junction");
  const viaAlias = scene(alias, rootsOf(alias));
  await viaAlias.watcher.tick();
  assert.equal(viaAlias.watcher.watched().length, 1, "offered under the alias grant");
  await viaAlias.runner.pass();
  assert.deepEqual(viaAlias.runs, [l.target], "the alias root is judged by where it really leads, as the watcher judges it");
});
