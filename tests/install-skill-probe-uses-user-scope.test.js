// The real guided CLI runs a private Codex probe from the user's scope.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CredentialInstallFixture, PEER_REQUIRED, ROOT } from "./fixtures/install-credentials.mjs";

const SERVICE = "toy-skill-provider";
const PACKAGE = "toy-skill-package";
const ARTIFACT = "skill-package";
const BIN = "not-an-assets-installer";
const slash = value => value.split(path.sep).join("/");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const present = folder => fs.readFileSync(path.join(folder, "SKILL.md"), "utf8");

for (const userShadow of [false, true]) {
  test(`the guided entry from a project ${userShadow ? "still refuses a user-level shadow" : "ignores its project skills"}`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t, { required: false, probe: false });
    const rev = "a".repeat(40);
    const artifact = { id: ARTIFACT, kind: "package", source: { git: { repo: "example/toy", revision: rev } }, entries: [BIN] };
    Object.assign(f.spec, { name: SERVICE, secrets: [], artifacts: [artifact] });
    const { tupleDigest } = await import(pathToFileURL(path.join(f.wrapperRoot, "lib/service-spec.mjs")).href);
    const approval = tupleDigest(artifact);
    const prefix = path.join(f.home, ".aify", "packages", SERVICE, ARTIFACT, rev);
    const pkg = path.join(prefix, "node_modules", PACKAGE);
    const skill = (root, bytes) => {
      const dir = path.join(root, "alpha");
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "SKILL.md"), bytes);
      return dir;
    };
    skill(path.join(pkg, "skills"), "approved skill");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: PACKAGE, aifySkills: { directory: "skills" } }));

    const project = path.join(f.home, "checkout");
    const checkoutCopy = skill(path.join(project, ".agents", "skills"), "project copy");
    const userCopy = userShadow ? skill(path.join(f.home, ".agents", "skills"), "user copy") : null;
    const trace = path.join(f.home, "probe-cwd.json");
    const probe = path.join(f.home, "codex-probe.mjs");
    fs.writeFileSync(probe, `import fs from 'node:fs';import path from 'node:path';
if (process.argv.slice(2).join(' ') !== 'debug prompt-input') throw Error('unexpected probe');
const cwd = process.cwd();
fs.writeFileSync(process.env.FIXTURE_PROBE_TRACE, JSON.stringify(cwd));
const roots = [path.join(process.env.CODEX_HOME, 'skills')];
for (const dir of new Set([process.env.HOME, cwd])) {
  const root = path.join(dir, '.agents', 'skills');
  if (fs.existsSync(root)) roots.push(root);
}
const rows = roots.map((root, i) => '- \u0060r' + i + '\u0060 = \u0060' + root.split(path.sep).join('/') + '\u0060');
process.stdout.write(JSON.stringify([{content:[{text:'<skills_instructions>\\n' + rows.join('\\n') + '\\n</skills_instructions>'}]}]));`);
    const win = process.platform === "win32";
    const codexTools = path.join(f.home, "codex-tools");
    fs.mkdirSync(codexTools);
    const launcher = path.join(codexTools, win ? "codex.cmd" : "codex");
    fs.writeFileSync(launcher, win ? '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_CODEX_PROBE%" %*\r\n'
      : '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_CODEX_PROBE" "$@"\n', { mode: 0o755 });

    // Use the real guided entry and its placement. Only the already accepted package and the runtime answer are fixtures.
    const lib = path.join(f.wrapperRoot, "lib");
    fs.writeFileSync(path.join(lib, "channel-install.mjs"), "export const channelPolicyReadiness = () => ({state:'ready'});\n");
    fs.renameSync(path.join(lib, "package-install.mjs"), path.join(lib, "package-install-real.mjs"));
    const listing = { dependencies: { [PACKAGE]: { resolved: `git+https://example.invalid/example/toy#${rev}` } } };
    fs.writeFileSync(path.join(lib, "package-install.mjs"), `export { installedCommit, binFiles, npmCliBeside } from './package-install-real.mjs';
export const npmTool = () => args => {
  if (args[0] !== 'ls' || args[2] !== ${JSON.stringify(prefix)}) throw Error('unexpected package query');
  return ${JSON.stringify(JSON.stringify(listing))};
};`);
    fs.writeFileSync(path.join(f.wrapperRoot, "bin/aify-wrapper-connect.mjs"), `import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2), arg=k=>a[a.indexOf(k)+1], registry=arg('--registry');
fs.mkdirSync(path.dirname(registry),{recursive:true});
fs.writeFileSync(registry, JSON.stringify({version:1,services:{[a[0]]:{endpoint:a[1]}}}));
fs.writeFileSync(arg('--report-file'), ${JSON.stringify(JSON.stringify({ installed: [{ id: ARTIFACT, at: slash(pkg) }], pending: [] }))});`);
    const env = f.prepareGuidedWrapper();
    const codexHome = path.join(f.home, "codex-home");
    Object.assign(env, { PATH: codexTools + path.delimiter + env.PATH, CODEX_HOME: codexHome,
      FIXTURE_NODE: process.execPath, FIXTURE_CODEX_PROBE: probe, FIXTURE_PROBE_TRACE: trace });
    const args = [path.join(ROOT, "bin/aify-env-install.mjs"), "--connect", `${SERVICE}=${f.endpoint}`, "--client", "codex", "--approve", approval, "--no-prompt"];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, cwd: project, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
      let log = "";
      child.stdout.on("data", bytes => { log += bytes; }); child.stderr.on("data", bytes => { log += bytes; });
      child.once("error", reject); child.once("close", status => resolve({ status, log }));
    });
    const installed = path.join(codexHome, "skills", "alpha");
    assert.equal(result.status, userShadow ? 78 : 0, result.log);
    assert.equal(readJson(trace), f.home, "the actual probe observes the user's home, not the installer's project");
    assert.equal(present(checkoutCopy), "project copy");
    if (userShadow) {
      assert.match(result.log, /would shadow this skill/);
      assert.ok(slash(result.log).includes(slash(userCopy)), result.log);
      assert.ok(!slash(result.log).includes(slash(checkoutCopy)), result.log);
      assert.equal(present(userCopy), "user copy");
      assert.equal(fs.existsSync(installed), false);
    } else {
      assert.equal(present(installed), "approved skill");
    }
  });
}
