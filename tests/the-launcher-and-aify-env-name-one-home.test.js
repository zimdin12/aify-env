// B1 contract item 1: the launcher and aify-env resolve ONE identity for the aify home, so the record a resident's
// launcher writes is in the home whose residents role the daemon holds.
//
// BOTH SIDES RUN FOR REAL. The launcher side is aify-wrapper's own `aify_lifetime_start`, sourced from its checkout and
// run by Bash, writing a real record (only its PID lookup is replaced); where that record landed is the launcher's
// home. The aify-env side is `os.homedir()` asked by a Node child given the same environment, which is what a daemon
// started from that environment resolves. Each home goes through lib/residents-home.mjs's identity, as the role does.
//
// THE ROWS ARE THE SPELLINGS THAT DIFFER: Git Bash's `/c/...` HOME beside a `C:\...` USERPROFILE, a case difference,
// an 8.3 short name, a junction, and a HOME that names another directory entirely (a HOME set in the Windows
// environment), where the launcher must follow USERPROFILE as Node does. The wrapper checkout is AIFY_WRAPPER_REPO,
// else beside this one, else ~/projects/aify-wrapper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { aifyHomeOf, homeIdentity, roleEndpoint } from "../lib/residents-home.mjs";

const here = path.resolve(import.meta.dirname, "..");
const WRAPPER = [process.env.AIFY_WRAPPER_REPO, path.join(path.dirname(here), "aify-wrapper"),
  path.join(os.userInfo().homedir, "projects", "aify-wrapper")]
  .filter(Boolean).find((dir) => fs.existsSync(path.join(dir, "bin", "aify-lifetime.sh")));
const identityOf = (dir) => homeIdentity(dir, { platform: process.platform, realpath: fs.realpathSync.native });
const gitPath = (value) => value.split(path.sep).join("/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function bash() {
  const name = process.platform === "win32" ? "bash.exe" : "bash";
  return (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
}

/** Where the real launcher writes a resident's record, given HOME and USERPROFILE. */
function launcherHome(root, env) {
  const bridge = path.join(root, "bridge"), bin = path.join(bridge, "node_modules", "aify-wrapper", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["aify-lease.sh", "aify-lifetime.sh", "aify-resident-record.mjs"]) fs.copyFileSync(path.join(WRAPPER, "bin", name), path.join(bin, name));
  const script = `set -eu
. "$1/node_modules/aify-wrapper/bin/aify-lease.sh"
aify_lease_pid() { printf 4242; }
EPOCHREALTIME=1780000000.123456
aify_lifetime_start home-proof claude resident
printf '%s\\n%s\\n' "$AIFY_RESIDENT_RECORD" "$AIFY_ENV_INSTANCE"`;
  const run = spawnSync(bash(), ["--noprofile", "--norc", "-c", script, "/fake/claude-aify", bridge.split(path.sep).join("/")],
    { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const [record, instance] = run.stdout.trim().split("\n");
  assert.equal(instance, "residents", "the launcher exports the role's instance for the hooks");
  assert.ok(fs.existsSync(record), `the launcher reported a record it did not write: ${record}`);
  return path.dirname(path.dirname(record));
}

/** The home a daemon started with this environment resolves: Node's own homedir(), in a child given the env. */
function daemonHome(env) {
  const run = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"],
    { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return aifyHomeOf(run.stdout);
}

function shortName(dir) {
  const run = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${dir}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true });
  const short = run.stdout.trim();
  return run.status === 0 && short && short.toLowerCase() !== dir.toLowerCase() ? short : null;
}

test("the launcher's record lands in the home aify-env resolves, for every spelling of it", {
  skip: !WRAPPER ? "no aify-wrapper checkout: set AIFY_WRAPPER_REPO" : !bash() ? "no Bash on PATH" : false, timeout: 120000,
}, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "aify-one-home-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, "User Profile");
  fs.mkdirSync(path.join(user, ".aify"), { recursive: true });
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const linked = path.join(root, "linked");
  fs.symlinkSync(user, linked, process.platform === "win32" ? "junction" : "dir");
  const rows = process.platform === "win32" ? [
    ["Git Bash HOME, native USERPROFILE", { HOME: gitPath(user), USERPROFILE: user }],
    ["a case difference", { HOME: gitPath(user), USERPROFILE: user.toUpperCase() }],
    ["a junction", { HOME: gitPath(linked), USERPROFILE: linked }],
    ["a HOME naming another directory", { HOME: gitPath(elsewhere), USERPROFILE: user }],
    ...(shortName(user) ? [["an 8.3 short name", { HOME: gitPath(user), USERPROFILE: shortName(user) }]] : []),
  ] : [
    ["the home itself", { HOME: user }],
    ["a symbolic link", { HOME: linked }],
  ];
  assert.ok(process.platform !== "win32" || rows.length >= 4);
  if (process.platform === "win32" && !shortName(user)) t.diagnostic("no 8.3 name on this volume: that row did not run");
  const expected = identityOf(path.join(user, ".aify"));
  assert.equal(expected.ok, true, expected.reason);
  for (const [name, env] of rows) {
    const box = fs.mkdtempSync(path.join(root, "box-"));
    const launcher = identityOf(launcherHome(box, env));
    const daemon = identityOf(daemonHome(env));
    assert.deepEqual(launcher, expected, `${name}: the launcher wrote under another home`);
    assert.deepEqual(daemon, expected, `${name}: aify-env resolved another home`);
    assert.equal(roleEndpoint(launcher.identity, process.platform), roleEndpoint(daemon.identity, process.platform), `${name}: two role names`);
    fs.rmSync(path.join(user, ".aify", "residents"), { recursive: true, force: true });
  }
  // NEGATIVE CONTROL: the comparison can say no. A different home is a different identity and a different lock.
  const other = identityOf(path.join(elsewhere));
  assert.notDeepEqual(other, expected);
  assert.notEqual(roleEndpoint(other.identity, process.platform), roleEndpoint(expected.identity, process.platform));
});
