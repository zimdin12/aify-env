// Real connect admission and receipt, real assets phase and real copies. The npm/CLI inputs
// are owned fixtures; neither a consumer installer nor a toy package bin may run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { InstallChain, parseChainArgs } from "../lib/install-chain.mjs";
import { approvedInstaller, envWithout, packageAssets, registryKeyEnv } from "../lib/install-chain-host.mjs";
import { SkillPlacer, skillDirectory } from "../lib/install-skills.mjs";
import { HERMES_PROBE, resolveSkillRoot } from "../lib/skill-roots.mjs";
import { CredentialInstallFixture, PEER_REQUIRED, ROOT } from "./fixtures/install-credentials.mjs";

const SERVICE = "toy-skill-provider";
const PACKAGE = "toy-skill-package";
const ARTIFACT = "skill-package";
const BIN = "not-an-assets-installer";
const clients = ["claude", "codex", "hermes"];
const slash = value => value.split(path.sep).join("/");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const present = (folder, file = "SKILL.md") => fs.readFileSync(path.join(folder, file), "utf8");
const under = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`); };

function fencedFs(home, fault) {
  const check = file => assert.ok(typeof file === "string" && under(home, file), `a skill write escaped the scratch home: ${file}`);
  const io = { ...fs };
  for (const name of ["mkdirSync", "mkdtempSync", "rmSync", "unlinkSync", "rmdirSync", "writeFileSync", "renameSync"]) {
    io[name] = (file, ...args) => {
      check(file);
      if (name === "renameSync") check(args[0]);
      fault?.(name, file);
      return fs[name](file, ...args);
    };
  }
  return io;
}

async function toy(t) {
  const f = await CredentialInstallFixture.create(t, { required: false, probe: false });
  f.spec.name = SERVICE;
  f.spec.secrets = [];
  const wrapper = file => import(pathToFileURL(path.join(f.wrapperRoot, "lib", file)).href);
  const [{ connect, aifyEnvTools }, { connectRecord }, { fetchSpec }, { validateSpec, tupleDigest }, { installedCommit, binFiles }] = await Promise.all([
    wrapper("connect.mjs"), wrapper("connect-report.mjs"), wrapper("connect-http.mjs"), wrapper("service-spec.mjs"), wrapper("package-install.mjs"),
  ]);
  const owner = path.join(f.home, "owner.mjs");
  fs.writeFileSync(owner, `import {pathToFileURL} from 'node:url'; import path from 'node:path';
const [kind,...args]=process.argv.slice(2); if(kind!=='registry')throw Error('fixture command refused');
const file=path.join(${JSON.stringify(ROOT)},'bin','aify-env-registry.mjs'); process.argv=[process.execPath,file,...args]; await import(pathToFileURL(file).href);`);
  const env = f.environment({ CLAUDE_CONFIG_DIR: path.join(f.home, "custom-claude"), CODEX_HOME: path.join(f.home, "custom-codex"),
    HERMES_HOME: path.join(f.home, "custom-hermes"), AIFY_HERMES_AGENT: path.join(f.home, "custom-hermes", "hermes-agent"),
    XDG_CONFIG_HOME: path.join(f.home, "xdg"), FIXTURE_SERVICE_KEY: "must-not-be-recorded" });
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "AIFY_HERMES_AGENT", "XDG_CONFIG_HOME"]) {
    assert.ok(under(f.home, env[name]), name);
  }
  const roots = { claude: path.join(env.CLAUDE_CONFIG_DIR, "skills"), codex: path.join(env.CODEX_HOME, "skills"),
    hermes: path.join(env.HERMES_HOME, "skills", "autonomous-ai-agents") };
  const packageRoot = path.join(f.home, ".aify", "packages");
  const receiptFile = path.join(f.home, ".aify", "installed-skills.json");
  const rows = () => fs.existsSync(receiptFile) ? readJson(receiptFile).placements : [];
  const outer = fencedFs(f.home);
  assert.throws(() => outer.writeFileSync(path.join(os.tmpdir(), "toy-must-not-write"), "never"), /escaped the scratch home/);
  const fileSetRoot = path.join(f.home, "file-set");
  const sources = path.join(f.home, "approved-file-set");
  const hookFile = path.join(f.home, "turn-start.fixture");
  const hook = "verified fixture turn-start payload";
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const manifest = `${digest(hook)}  turn-start.fixture\n`;
  const fileSet = { kind: "file-set", id: "hooks", source: { git: { repo: "example/hooks", revision: "1".repeat(40) } },
    entries: ["turn-start.fixture"], manifest: { path: "/toy-file-set.manifest" }, sha256: digest(manifest) };
  outer.mkdirSync(fileSetRoot);
  outer.writeFileSync(path.join(fileSetRoot, "turn-start.fixture"), hook);
  const [serve] = f.server.listeners("request");
  f.server.removeListener("request", serve);
  f.server.on("request", (req, res) => {
    if (req.url === fileSet.manifest.path) {
      res.setHeader("content-type", "text/plain");
      return res.end(manifest);
    }
    return serve(req, res);
  });
  let variant, accepted, artifact, approval;
  const npm = args => {
    assert.ok(["ls", "install"].includes(args[0]));
    const prefix = args[args.indexOf("--prefix") + 1];
    assert.ok(under(packageRoot, prefix));
    const dir = path.join(prefix, "node_modules", PACKAGE);
    if (args[0] === "ls") return JSON.stringify({ dependencies: fs.existsSync(dir) ? {
      [PACKAGE]: { resolved: `git+https://example.invalid/toy/repo#${artifact.source.git.revision}` },
    } : {} });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bin", "never.mjs"), 'throw Error("the toy bin was executed");');
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PACKAGE, bin: { [BIN]: "bin/never.mjs" }, aifySkills: { directory: "skills" } }));
    fs.mkdirSync(path.join(dir, "skills"));
    for (const [name, content] of Object.entries(variant)) {
      const folder = path.join(dir, "skills", name);
      fs.mkdirSync(path.join(folder, "notes"), { recursive: true });
      fs.writeFileSync(path.join(folder, "SKILL.md"), content);
      fs.writeFileSync(path.join(folder, "notes", "example.md"), "extra fixture file");
    }
    return "";
  };
  const thenAssets = (approved = [approval], installed = accepted, options) => packageAssets(SERVICE, f.endpoint, {
    fetchSpec, validateSpec, tupleDigest, packageRoot, installedCommit, binFiles, approve: approved, accepted: installed, npmLs: prefix => JSON.parse(npm(["ls", "--prefix", prefix])),
    ...options,
  });
  const run = async (selected, generation, skills, fault, { fileSetExit } = {}) => {
    variant = skills;
    artifact = { id: ARTIFACT, kind: "package", source: { git: { repo: "example/toy", revision: generation.repeat(40) } }, entries: [BIN] };
    const mixed = fileSetExit !== undefined;
    f.spec.artifacts = mixed ? [fileSet, artifact] : [artifact];
    approval = tupleDigest(artifact);
    const approvals = f.spec.artifacts.map(tupleDigest);
    const placer = new SkillPlacer({ home: f.home, io: fencedFs(f.home, fault) });
    const events = [], problems = [];
    const installer = path.join(sources, SERVICE, fileSet.source.git.revision, "install.sh");
    let registryBytes;
    const io = {
      env, say: line => problems.push(line), ensurePackages: async () => true, unapproved: async () => [],
      policyReadiness: () => ({ state: "ready" }),
      approvedInstaller: (name, url, approve) => approvedInstaller(name, url, { fetchSpec, validateSpec, tupleDigest, catalogue: [], approve, sources,
        checkout: (repo, revision, dir) => {
          assert.deepEqual({ repo, revision }, fileSet.source.git);
          assert.equal(path.join(dir, "install.sh"), installer);
          outer.mkdirSync(dir, { recursive: true });
          outer.writeFileSync(installer, "fixture only; never execute it");
          return { ok: true, head: revision };
        },
      }),
      connect: async () => {
        const report = await connect({ name: SERVICE, endpoint: f.endpoint, secrets: {}, approved: new Set(approvals),
          registryPath: f.registry, home: f.home, dest: path.join(f.home, "launchers"), wrapperRoot: f.wrapperRoot,
          execPath: process.execPath, env, readStored: () => "", packageRoot, fileSetRoot, stagingDir: path.join(f.home, "staging"),
          tools: aifyEnvTools(owner, env), npm });
        const record = connectRecord(report);
        assert.equal(record.result, "committed");
        accepted = Object.fromEntries(record.installed.map(({ id, at }) => [id, at]));
        registryBytes = fs.readFileSync(f.registry);
        events.push("connect");
        return { status: 0, installed: accepted };
      },
      packageAssets: (_name, _url, approved, installed, options) => thenAssets(approved, installed, options),
      render: () => assert.fail("the toy service does not render launchers"),
      cliPresent: client => selected.includes(client),
      registryHash: () => fs.readFileSync(f.registry).toString("utf8"),
      keyEnv: names => registryKeyEnv(f.registry, names),
      runInstaller: (file, argv, options) => {
        assert.ok(mixed, "a declarative package must not execute any installer or bin");
        assert.equal(file, installer, "only the acquired file-set installer may run");
        if (argv[0] === "--acquire-only") {
          assert.deepEqual(argv, ["--acquire-only", f.endpoint]);
          assert.deepEqual(options, { quiet: true });
          events.push("file-set-acquire");
          return 0;
        }
        assert.deepEqual(argv, ["--assets-only", "--client", "claude", f.endpoint]);
        assert.deepEqual(options, { without: ["FIXTURE_SERVICE_KEY"], quiet: true });
        assert.equal(envWithout(env, options.without).FIXTURE_SERVICE_KEY, undefined);
        events.push("file-set-assets");
        if (fileSetExit === 0) outer.writeFileSync(hookFile, present(fileSetRoot, "turn-start.fixture"));
        return fileSetExit;
      },
      placeSkills: (assets, client, { without }) => {
        assert.deepEqual(without, ["FIXTURE_SERVICE_KEY"]);
        events.push(client);
        const runtime = resolveSkillRoot(client, {
          home: f.home, env: envWithout(env, without), windows: process.platform === "win32", cwd: f.home,
          find: name => { assert.equal(name, "codex"); return path.join(f.bin, name); },
          run: (file, args, options) => {
            assert.ok(under(f.home, file), "only an owned test runtime can be selected");
            assert.equal(options.env.FIXTURE_SERVICE_KEY, undefined);
            assert.ok(under(f.home, options.env.HOME));
            if (client === "codex") {
              assert.deepEqual(args, ["debug", "prompt-input"]);
              const text = `<skills_instructions>\n- \`r0\` = \`${slash(roots.codex)}\`\n</skills_instructions>`;
              return { status: 0, stdout: JSON.stringify([{ content: [{ text }] }]) };
            }
            assert.equal(client, "hermes");
            assert.deepEqual(args, ["-B", HERMES_PROBE, "--cwd", f.home]);
            const skillsDir = path.dirname(roots.hermes);
            return { status: 0, stdout: JSON.stringify({ hermesHome: env.HERMES_HOME, skillsDir, searchRoots: [skillsDir] }) };
          },
        });
        assert.equal(runtime.problem, null);
        assert.equal(runtime.root, slash(roots[client]));
        placer.place(assets, client, runtime);
      },
    };
    const plan = parseChainArgs(["--connect", `${SERVICE}=${f.endpoint}`, "--no-prompt", ...approvals.flatMap(hash => ["--approve", hash]), ...selected.flatMap(client => ["--client", client])]);
    const result = await new InstallChain(plan, io).run();
    assert.deepEqual(fs.readFileSync(f.registry), registryBytes, "assets may not alter the registry, including after failure");
    assert.equal(events[mixed ? 1 : 0], "connect", "package custody must precede placement");
    assert.equal(fs.existsSync(path.join(f.home, ".claude")), false, "must not use the default Claude home");
    assert.equal(fs.existsSync(path.join(f.home, ".codex")), false, "must not use the default Codex home");
    assert.equal(fs.existsSync(path.join(f.home, ".hermes")), false, "must not use the default Hermes home");
    if (fs.existsSync(receiptFile)) assert.doesNotMatch(fs.readFileSync(receiptFile, "utf8"), /must-not-be-recorded/);
    return { result, events, problems };
  };
  return { f, run, roots, rows, thenAssets };
}

test("an approved toy package places, updates and removes skills through the existing assets phase", { skip: PEER_REQUIRED }, async t => {
  const b = await toy(t);
  const first = await b.run(clients, "a", { alpha: "first", retire: "old" });
  assert.equal(first.result.exit, 0, first.problems.join("\n"));
  assert.deepEqual(first.events, ["connect", ...clients]);
  assert.equal(b.rows().length, 6);
  for (const row of b.rows()) {
    assert.equal(row.service, SERVICE);
    assert.equal(row.source.artifact, ARTIFACT);
    assert.equal(row.destination, path.join(b.roots[row.harness], row.skill));
    assert.equal(row.source.path, `skills/${row.skill}`);
    assert.equal(row.source.revision, "a".repeat(40));
    assert.match(row.digest, /^[0-9a-f]{64}$/);
    assert.equal(present(row.destination), row.skill === "alpha" ? "first" : "old");
  }
  const second = await b.run(clients, "b", { alpha: "revised" });
  assert.equal(second.result.exit, 0, second.problems.join("\n"));
  assert.equal(b.rows().length, 3);
  for (const client of clients) {
    assert.equal(present(path.join(b.roots[client], "alpha")), "revised");
    assert.equal(fs.existsSync(path.join(b.roots[client], "retire")), false);
  }
  assert.ok(b.rows().every(row => row.skill === "alpha" && row.source.revision === "b".repeat(40)));
  assert.match((await b.thenAssets([])).problem, /not approved/);
  assert.match((await b.thenAssets(undefined, {})).problem, /not the package connect installed in this run/);
});

test("the file-set step keeps its turn-start payload and an accepted package places the declared skill", { skip: PEER_REQUIRED }, async t => {
  const b = await toy(t);
  const { result, problems, events } = await b.run(["claude"], "1", { alpha: "mixed skill" }, undefined, { fileSetExit: 0 });
  assert.equal(result.exit, 0, problems.join("\n"));
  assert.equal(present(b.f.home, "turn-start.fixture"), "verified fixture turn-start payload");
  assert.deepEqual(events, ["file-set-acquire", "connect", "file-set-assets", "claude"], "the accepted package must place its skill after file-set assets");
  assert.equal(present(path.join(b.roots.claude, "alpha")), "mixed skill");
  assert.equal(b.rows().length, 1);
});

test("failed file-set assets leave the previous skill and receipt unchanged", { skip: PEER_REQUIRED }, async t => {
  const b = await toy(t);
  const prior = await b.run(["claude"], "2", { alpha: "previous" });
  assert.equal(prior.result.exit, 0, prior.problems.join("\n"));
  const receipt = path.join(b.f.home, ".aify", "installed-skills.json");
  const before = fs.readFileSync(receipt);
  const { result, problems, events } = await b.run(["claude"], "3", { alpha: "not placed", beta: "not placed" }, undefined, { fileSetExit: 1 });
  assert.equal(result.exit, 78);
  assert.match(problems.join("\n"), /assets toy-skill-provider for claude failed/);
  assert.deepEqual(events, ["file-set-acquire", "connect", "file-set-assets"], "a file-set failure stops before declared placement");
  assert.equal(present(path.join(b.roots.claude, "alpha")), "previous");
  assert.equal(fs.existsSync(path.join(b.roots.claude, "beta")), false);
  assert.deepEqual(fs.readFileSync(receipt), before);
});

test("unmanaged and linked destinations are refused without changing the destination or the receipt", { skip: PEER_REQUIRED }, async t => {
  const b = await toy(t);
  const dest = path.join(b.roots.claude, "alpha");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"), "private owned by user");
  const collision = await b.run(["claude"], "c", { alpha: "new" });
  assert.equal(collision.result.exit, 78);
  assert.match(collision.problems.join("\n"), /unmanaged or changed/);
  assert.equal(present(dest), "private owned by user");
  assert.deepEqual(b.rows(), []);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skills-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "SKILL.md"), "outside control");
  const link = path.join(b.roots.claude, "linked");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const refused = await b.run(["claude"], "d", { linked: "new" });
  assert.equal(refused.result.exit, 78);
  assert.match(refused.problems.join("\n"), /is a link; nothing follows it/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(present(outside), "outside control");
  assert.deepEqual(b.rows(), []);
});

test("a later failed copy rolls back its own writes and retains only the earlier read-back placement", { skip: PEER_REQUIRED }, async t => {
  const b = await toy(t);
  const failAt = path.join(b.roots.codex, "beta", "notes", "example.md");
  const first = await b.run(["codex"], "e", { alpha: "before", beta: "before" });
  assert.equal(first.result.exit, 0, first.problems.join("\n"));
  const originalBeta = b.rows().find(row => row.skill === "beta");
  const failed = await b.run(["codex"], "f", { alpha: "after", beta: "after" }, (name, file) => {
    if (name === "writeFileSync" && file === failAt) {
      fs.writeFileSync(file, "extra fixture", { flag: "wx" });
      throw new Error("fixture copy refused after writing a prefix");
    }
  });
  assert.equal(failed.result.exit, 78);
  assert.match(failed.problems.join("\n"), /fixture copy refused/);
  assert.equal(present(path.join(b.roots.codex, "alpha")), "after");
  assert.equal(present(path.join(b.roots.codex, "beta")), "before");
  assert.deepEqual(b.rows().find(row => row.skill === "beta"), originalBeta);
  assert.equal(b.rows().find(row => row.skill === "alpha").source.revision, "f".repeat(40));
  assert.equal(b.rows().length, 2);
});

test("skillDirectory selects only a portable relative tree", () => {
  assert.equal(skillDirectory({ directory: "assets/skills" }), "assets/skills");
  for (const directory of ["/skills", "../skills", "skills/..", "C:/skills", "x\\skills", "skills//x", "con", "skills."]) {
    assert.equal(skillDirectory({ directory }), null, directory);
  }
  assert.equal(skillDirectory({ directory: "skills", command: "never" }), null);
});
