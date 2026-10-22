// Guided install S2: the chain's order and rules (lib/install-chain.mjs), against fake host ports. The container
// witnesses of the plan's table run the real installers; these pin each rule where it is decided.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CHAIN_MARK, CLIENTS, EXIT_OK, EXIT_REFUSED, InstallChain, LAUNCHER_SERVICE, USAGE, parseChainArgs } from "../lib/install-chain.mjs";
import { acceptedPackages, approvedInstaller, envWithout, gitCheckout, hasPublishedKey, packageAssets, registryKeyEnv, registryPath, runMarked, runMarkedCapture, wrapperModules } from "../lib/install-chain-host.mjs";

const COMMS = "aify-comms=http://comms.test:8800";
const plan = (...extra) => parseChainArgs(["--connect", COMMS, "--client", "claude", "--secret", "aify-comms.credentialRef=/k", ...extra]);

/** Fake ports that record every call in order. */
function host({ present = [], published = false, connectExit = 0, env = {}, installer = { path: "/src/install.sh" }, assetsWrite = false, assetsExit = 0, pkgAssets = null, installed = {}, keyEnv = { "aify-comms": ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"] }, packages = true } = {}) {
  const calls = [];
  const registry = { bytes: "R1" };
  const io = {
    env, said: [],
    say(line) { this.said.push(line); },
    ask: async () => "",
    publishedKey: async (name) => { calls.push(["publishedKey", name]); return published; },
    ensurePackages: async () => { calls.push(["ensurePackages"]); return packages; },
    approvedInstaller: async (name) => { calls.push(["approvedInstaller", name]); return installer; },
    runInstaller: async (file, args, opts = {}) => { calls.push(["installer", file, ...args]); if (args[0] === "--assets-only") calls.push(["without", ...(opts.without ?? [])]); calls.push(["quiet", args[0], opts.quiet === true]); if (assetsWrite && args[0] === "--assets-only") registry.bytes = "R2"; return args[0] === "--assets-only" ? assetsExit : 0; },
    connect: async (c) => { calls.push(["connect", c.name, c.keys.map((k) => `${k.field}=${k.file}`).join()]); return { status: connectExit, installed: installed[c.name] ?? {} }; },
    render: async (client, url) => { calls.push(["render", client, url]); return 0; },
    cliPresent: (client) => present.includes(client),
    packageAssets: async (name, url, approve, accepted) => { calls.push(["packageAssets", name, accepted]); return pkgAssets; },
    registryHash: async () => { calls.push(["registryHash"]); return registry.bytes; },
    keyEnv: async (names) => { if (keyEnv instanceof Error) throw keyEnv; return names.flatMap((n) => keyEnv[n] ?? []); },
  };
  return { io, calls };
}

test("render comes after connect, and a selected client whose CLI is absent fails a --no-prompt run, named", async () => {
  const { io, calls } = host();
  const { exit, report } = await new InstallChain(plan("--no-prompt"), io).run();
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf("connect") < order.indexOf("render"), `render before connect: ${order}`);
  assert.ok(order.indexOf("installer") < order.indexOf("connect"), "acquire before connect");
  assert.deepEqual(calls.find((c) => c[0] === "installer"), ["installer", "/src/install.sh", "--acquire-only", "http://comms.test:8800"]);
  assert.deepEqual(report.pending, ["claude: pending (CLI absent)"]);
  assert.equal(exit, EXIT_REFUSED);
  assert.ok(io.said.includes("pending: claude: pending (CLI absent)"));
  assert.ok(!calls.some((c) => c[0] === "installer" && c.includes("--assets-only")), "assets ran for an absent CLI");
});

test("control: the same run with the CLI present applies assets after render and completes", async () => {
  const { io, calls } = host({ present: ["claude"] });
  const { exit } = await new InstallChain(plan("--no-prompt"), io).run();
  const order = calls.map((c) => c[0]);
  assert.equal(exit, EXIT_OK);
  assert.ok(order.lastIndexOf("installer") > order.indexOf("render"));
  assert.deepEqual(calls.at(-4), ["installer", "/src/install.sh", "--assets-only", "--client", "claude", "http://comms.test:8800"]);
  assert.ok(io.said.includes("registry before assets: R1") && io.said.includes("registry after assets: R1"));
});

test("every assets installer starts without the key variables any connected service names", async () => {
  const { io, calls } = host({ present: ["claude"] });
  const { exit } = await new InstallChain(plan("--no-prompt"), io).run();
  assert.equal(exit, EXIT_OK);
  assert.deepEqual(calls.filter((c) => c[0] === "without"), [["without", "CLAUDE_MCP_API_KEY", "AIFY_API_KEY"]]);
});

test("a registry whose key variables cannot be read stops assets, never runs them with the key inherited", async () => {
  const { io, calls } = host({ present: ["claude"], keyEnv: new Error("unreadable") });
  const { exit, report } = await new InstallChain(plan("--no-prompt"), io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.match(report.problems[0], /assets: the key variables to withhold could not be read: unreadable/);
  assert.ok(!calls.some((c) => c[0] === "installer" && c[2] === "--assets-only"));
});

test("every installer the chain runs is told it may not ask: stdin closed and the no-prompt contract set", async () => {
  const { io, calls } = host({ present: ["claude"] });
  await new InstallChain(plan(), io).run();
  assert.deepEqual(calls.filter((c) => c[0] === "quiet"), [["quiet", "--acquire-only", true], ["quiet", "--assets-only", true]]);
  const runs = [];
  const run = (command, args, options) => { runs.push(options); return { status: 0 }; };
  runMarked("bash", ["/x/install.sh", "--acquire-only"], { env: { A: "1" }, run, quiet: true });
  assert.equal(runs[0].stdio[0], "ignore");
  assert.equal(runs[0].env.AIFY_NO_PROMPT, "1");
  runMarked("bash", ["/x"], { env: {}, run });
  assert.equal(runs[1].stdio[0], "inherit", "CONTROL: a run not marked quiet keeps its terminal");
  assert.equal(runs[1].env.AIFY_NO_PROMPT, undefined);
});

test("an installed aify-wrapper that lacks what the chain needs is a reported refusal with guidance, not a crash", async () => {
  const { io, calls } = host({ present: ["claude"], packages: { problem: "the installed aify-wrapper at /g/aify-wrapper lacks lib/package-install.mjs" } });
  const { exit, report } = await new InstallChain(plan("--no-prompt"), io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.deepEqual(report.problems, ["acquire: the installed aify-wrapper at /g/aify-wrapper lacks lib/package-install.mjs"]);
  assert.ok(!calls.some((c) => c[0] === "connect"));
});

// The interface the chain calls, module by module: a wrapper whose files exist but lack one of these is as unusable
// as one missing the file (an undefined validateSpec escaped approvedInstaller's catch as a crash).
const WRAPPER_EXPORTS = {
  "connect-http.mjs": ["fetchSpec"],
  "service-spec.mjs": ["validateSpec", "tupleDigest"],
  "path-lookup.mjs": ["resolveOnPath"],
  "package-install.mjs": ["installedCommit", "binFiles", "npmTool", "npmCliBeside"],
};
function fakeWrapper({ skipFile = "", skipExport = "", catalogue = { approved: ["d1"] } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-wrapper-"));
  fs.mkdirSync(path.join(root, "lib"));
  for (const [file, names] of Object.entries(WRAPPER_EXPORTS)) {
    if (file === skipFile) continue;
    const body = names.filter((n) => n !== skipExport).map((n) => `export function ${n}() { return "${n}"; }`).join("\n");
    fs.writeFileSync(path.join(root, "lib", file), `${body}\n`);
  }
  fs.writeFileSync(path.join(root, "lib", "artifact-catalogue.json"), JSON.stringify(catalogue));
  return root;
}

test("a wrapper module is usable only with the functions and catalogue the chain calls, each checked", async () => {
  const usable = await wrapperModules(fakeWrapper());
  assert.equal(usable.problem, undefined, "CONTROL: a wrapper with every export loads");
  for (const [name, fn] of Object.entries(usable)) if (name !== "catalogue") assert.equal(fn(), name, `${name} is not the wrapper's own`);
  assert.deepEqual(usable.catalogue, ["d1"]);
  const noFile = await wrapperModules(fakeWrapper({ skipFile: "package-install.mjs" }));
  assert.match(noFile.problem, /lacks lib\/package-install\.mjs/);
  assert.match(noFile.problem, /npm install -g .*aify-wrapper.*git pull/s);
  for (const missing of ["validateSpec", "binFiles", "fetchSpec"]) {
    const noExport = await wrapperModules(fakeWrapper({ skipExport: missing }));
    assert.match(noExport.problem ?? "", new RegExp(`does not export ${missing}`), `a wrapper without ${missing} passed`);
    assert.match(noExport.problem, /npm install -g .*aify-wrapper.*git pull/s);
  }
  const badCatalogue = await wrapperModules(fakeWrapper({ catalogue: { approved: "d1" } }));
  assert.match(badCatalogue.problem ?? "", /artifact-catalogue\.json holds no approved list/);
});

test("an assets step that writes the registry fails the run, naming both hashes", async () => {
  const { io } = host({ present: ["claude"], assetsWrite: true });
  const { exit, report } = await new InstallChain(plan("--no-prompt"), io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.match(report.problems[0], /assets changed the registry \(R1 -> R2\)/);
});

test("envWithout drops the named variables whatever their case, and keeps the rest", () => {
  const env = { Path: "p", aify_api_key: "k1", CLAUDE_MCP_API_KEY: "k2", HOME: "h" };
  assert.deepEqual(envWithout(env, ["AIFY_API_KEY", "CLAUDE_MCP_API_KEY"]), { Path: "p", HOME: "h" });
  assert.deepEqual(envWithout(env, []), env, "CONTROL: nothing named, nothing dropped");
});

test("registryKeyEnv reads each connected service's keyEnv from the registry, and refuses one it cannot parse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-keyenv-"));
  const file = path.join(dir, "services.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, services: { "aify-comms": { keyEnv: ["AIFY_API_KEY"] }, other: { keyEnv: ["OTHER_KEY"] } } }));
  assert.deepEqual(registryKeyEnv(file, ["aify-comms"]), ["AIFY_API_KEY"]);
  fs.writeFileSync(file, "{not json");
  assert.throws(() => registryKeyEnv(file, ["aify-comms"]));
});

test("a package's assets bin that exits non-zero is a reported problem, never a skip", async () => {
  const bin = { command: "/node", args: ["/pkg/bin/aify-dashboard-assets.mjs"] };
  const { io, calls } = host({ present: ["claude"], published: true, installer: null, pkgAssets: bin, assetsExit: 1 });
  const dash = parseChainArgs(["--connect", "aify-dashboard=http://dash.test:9700", "--client", "claude", "--no-prompt"]);
  const { exit, report } = await new InstallChain(dash, io).run();
  assert.deepEqual(calls.find((c) => c[0] === "installer"), ["installer", bin, "--assets-only", "--client", "claude", "http://dash.test:9700"]);
  assert.equal(exit, EXIT_REFUSED);
  assert.deepEqual(report.problems, ["assets aify-dashboard for claude failed"]);
  assert.ok(io.said.includes("chain: not complete"));
});

test("without --no-prompt a pending client is reported, not failed", async () => {
  const { io } = host();
  const { exit, report } = await new InstallChain(plan(), io).run();
  assert.equal(exit, EXIT_OK);
  assert.deepEqual(report.pending, ["claude: pending (CLI absent)"]);
});

test("a missing key stops the run before anything is acquired, connected or rendered, naming it", async () => {
  const { io, calls } = host();
  const bare = parseChainArgs(["--connect", COMMS, "--client", "claude", "--no-prompt"]);
  const { exit, report } = await new InstallChain(bare, io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.match(report.problems[0], /missing aify-comms\.credentialRef/);
  assert.deepEqual(calls.map((c) => c[0]), ["publishedKey"]);
});

test("a key already published on this host is reused, so a reconnect needs none supplied", async () => {
  const { io, calls } = host({ present: ["claude"], published: true });
  const bare = parseChainArgs(["--connect", COMMS, "--client", "claude", "--no-prompt"]);
  const { exit } = await new InstallChain(bare, io).run();
  assert.equal(exit, EXIT_OK);
  assert.ok(calls.some((c) => c[0] === "connect"));
});

test("a failed connect stops the chain before render", async () => {
  const { io, calls } = host({ present: ["claude"], connectExit: 78 });
  const { exit, report } = await new InstallChain(plan("--no-prompt"), io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.match(report.problems[0], /connect aify-comms: exit 78/);
  assert.ok(!calls.some((c) => c[0] === "render"));
});

test("an unknown publish outcome is named as such", async () => {
  const { io } = host({ present: ["claude"], connectExit: 75 });
  const { report } = await new InstallChain(plan("--no-prompt"), io).run();
  assert.match(report.problems[0], /outcome unknown/);
});

test("entered once: under the chain's own mark it refuses to start, and its installers run only in their two modes", async () => {
  const marked = host({ env: { [CHAIN_MARK]: "1" } });
  const { exit, report } = await new InstallChain(plan(), marked.io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.match(report.problems[0], /entered once/);
  assert.deepEqual(marked.calls, []);
  const { io, calls } = host({ present: ["claude"] });
  await new InstallChain(plan(), io).run();
  const modes = calls.filter((c) => c[0] === "installer").map((c) => c[2]);
  assert.deepEqual(modes, ["--acquire-only", "--assets-only"]);
  assert.equal(io.said.filter((l) => l.startsWith("chain: entered")).length, 1);
});

test("PATH is not selection: a CLI on PATH that nobody selected gets no assets", async () => {
  const { io, calls } = host({ present: ["claude", "codex"] });
  await new InstallChain(plan(), io).run();
  assert.ok(!calls.some((c) => c.includes("codex")), "codex was touched");
  assert.ok(calls.some((c) => c.includes("claude")), "CONTROL: the selected client was set up");
});

test("with no --client, --no-prompt refuses rather than reading PATH; an asked run takes the answer", async () => {
  const { io, calls } = host({ present: ["codex"] });
  const none = parseChainArgs(["--connect", COMMS, "--no-prompt", "--secret", "aify-comms.credentialRef=/k"]);
  const { exit, report } = await new InstallChain(none, io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.match(report.problems[0], /PATH is never a selection/);
  assert.deepEqual(calls, []);
  const asked = host({ present: ["hermes"] });
  asked.io.ask = async () => "hermes";
  const open = parseChainArgs(["--connect", COMMS, "--secret", "aify-comms.credentialRef=/k"]);
  await new InstallChain(open, asked.io).run();
  assert.ok(asked.calls.some((c) => c[0] === "render" && c[1] === "hermes"));
});

test("an installer given by the entry point is used as is; a service without one acquires nothing", async () => {
  const given = host({ present: ["claude"] });
  await new InstallChain(plan("--installer", "aify-comms=/entry/install.sh"), given.io).run();
  assert.ok(!given.calls.some((c) => c[0] === "approvedInstaller"));
  assert.ok(given.calls.some((c) => c[0] === "installer" && c[1] === "/entry/install.sh"));
  const none = host({ present: ["claude"], installer: null });
  const { exit } = await new InstallChain(plan(), none.io).run();
  assert.equal(exit, EXIT_OK);
  assert.ok(!none.calls.some((c) => c[0] === "installer"));
  const refused = host({ installer: { problem: "not approved" } });
  const out = await new InstallChain(plan(), refused.io).run();
  assert.match(out.report.problems[0], /acquire aify-comms: not approved/);
  assert.ok(!refused.calls.some((c) => c[0] === "connect"));
});

test(`only ${LAUNCHER_SERVICE} renders launchers`, async () => {
  const { io, calls } = host({ present: ["claude"] });
  const dash = parseChainArgs(["--connect", "aify-dashboard=http://d.test:7000", "--client", "claude", "--secret", "aify-dashboard.credentialRef=/k"]);
  await new InstallChain(dash, io).run();
  assert.ok(!calls.some((c) => c[0] === "render"));
  assert.ok(io.said.some((l) => /no launcher rendered/.test(l)));
});

test("arguments: keys never in argv, every name checked, usage names the flags", () => {
  assert.match(parseChainArgs(["--connect", COMMS, "--key=abc"]).problem, /would put a key in argv/);
  assert.match(parseChainArgs(["--connect", COMMS, "--secret=x"]).problem, /would put a key in argv/);
  assert.match(parseChainArgs(["--client", "claude"]).problem, /at least one --connect/);
  assert.match(parseChainArgs(["--connect", COMMS, "--client", "vim"]).problem, /unknown client/);
  assert.match(parseChainArgs(["--connect", "aify-comms=ftp://x"]).problem, /not an http/);
  assert.match(parseChainArgs(["--connect", "aify-comms=http://u:p@x"]).problem, /without credentials/);
  assert.match(parseChainArgs(["--connect", COMMS, "--connect", COMMS]).problem, /connected twice/);
  assert.match(parseChainArgs(["--connect", COMMS, "--secret", "other.credentialRef=/k"]).problem, /not connected/);
  assert.match(parseChainArgs(["--connect", COMMS, "--secret", "aify-comms.apiKey=/k"]).problem, /credential reference field/);
  assert.match(parseChainArgs(["--connect", COMMS, "--secret-stdin", "aify-comms.credentialRef", "--secret", "aify-comms.credentialRef=/k"]).problem, /given twice/);
  assert.match(parseChainArgs(["--connect", COMMS, "--installer", "other=/x"]).problem, /not connected/);
  assert.match(parseChainArgs(["--connect", COMMS, "--frob"]).problem, /unknown option/);
  assert.match(parseChainArgs(["--connect", COMMS, "--secret-stdin", "aify-comms.secretsCredentialRef"]).problem, /--secret-stdin carries only a service's key \(credentialRef\)/);
  const ok = parseChainArgs(["--connect", COMMS, "--client", "claude", "--client", "claude", "--secret-stdin", "aify-comms.credentialRef", "--approve", "d1"]);
  assert.equal(ok.problem, "");
  assert.deepEqual(ok.clients, ["claude"]);
  assert.deepEqual(ok.secretStdin, { service: "aify-comms", field: "credentialRef" });
  for (const flag of ["--connect", "--client", "--secret", "--secret-stdin", "--approve", "--installer", "--no-prompt"]) assert.ok(USAGE.includes(flag), flag);
  assert.deepEqual(CLIENTS, ["claude", "codex", "hermes"]);
});

const SPEC = (artifacts) => ({ artifacts });
const GIT = { id: "comms-bridge", kind: "file-set", source: { git: { repo: "zimdin12/aify-comms", revision: "a".repeat(40) } }, sha256: "b".repeat(64), entries: ["server.js"] };
function ports(over = {}) {
  const sources = fs.mkdtempSync(path.join(os.tmpdir(), "chain-src-"));
  const seen = [];
  return {
    seen,
    fetchSpec: async () => SPEC([GIT]),
    validateSpec: (spec) => ({ ok: true, errors: [], spec }),
    tupleDigest: () => "D",
    catalogue: [],
    approve: ["D"],
    sources,
    checkout: (repo, revision, dir) => { seen.push([repo, revision]); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "install.sh"), ""); return { ok: true, head: revision }; },
    ...over,
  };
}

test("a service's installer runs only from an approved tuple, checked out at its exact revision", async () => {
  const p = ports();
  const out = await approvedInstaller("aify-comms", "http://c", p);
  assert.equal(out.path, path.join(p.sources, "aify-comms", "a".repeat(40), "install.sh"));
  assert.deepEqual(p.seen, [["zimdin12/aify-comms", "a".repeat(40)]]);

  const unapproved = ports({ approve: [] });
  assert.match((await approvedInstaller("aify-comms", "http://c", unapproved)).problem, /not approved; .*--approve D/);
  assert.deepEqual(unapproved.seen, [], "an unapproved tuple was checked out");
  assert.ok((await approvedInstaller("aify-comms", "http://c", ports({ approve: [], catalogue: ["D"] }))).path, "the catalogue approves");

  const moved = ports({ checkout: () => ({ ok: true, head: "c".repeat(40) }) });
  assert.match((await approvedInstaller("aify-comms", "http://c", moved)).problem, /not .*aaaa/);
  assert.match((await approvedInstaller("aify-comms", "http://c", ports({ validateSpec: () => ({ ok: false, errors: ["wrong name"] }) }))).problem, /refused: wrong name/);
  assert.match((await approvedInstaller("aify-comms", "http://c", ports({ fetchSpec: async () => { throw new Error("302"); } }))).problem, /could not be read: 302/);
  assert.equal(await approvedInstaller("aify-comms", "http://c", ports({ fetchSpec: async () => SPEC([{ ...GIT, kind: "package" }]) })), null);
  assert.match((await approvedInstaller("aify-comms", "http://c", ports({ fetchSpec: async () => SPEC([{ ...GIT, source: { git: { repo: "x", revision: "main" } } }]) }))).problem, /no exact repo/);
  assert.match((await approvedInstaller("aify-comms", "http://c", ports({ fetchSpec: async () => SPEC([GIT, { ...GIT, id: "two" }]) }))).problem, /more than one/);
});

test("a key counts as published only when the registry names a reference the store can read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-reg-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://c", credentialRef: "aify-comms.key" } } }));
  const ok = async ({ ref }) => ({ state: ref === "aify-comms.key" ? "ok" : "missing" });
  assert.equal(await hasPublishedKey("aify-comms", { registry, read: ok, root: dir }), true);
  assert.equal(await hasPublishedKey("aify-comms", { registry, read: async () => ({ state: "missing" }), root: dir }), false);
  assert.equal(await hasPublishedKey("aify-comms", { registry, read: async () => { throw new Error("EACCES"); }, root: dir }), false);
  assert.equal(await hasPublishedKey("aify-dashboard", { registry, read: ok, root: dir }), false);
  assert.equal(await hasPublishedKey("aify-comms", { registry: path.join(dir, "none.json"), read: ok, root: dir }), false);
  assert.equal(registryPath({ AIFY_SERVICE_REGISTRY: "/r.json" }, "/h"), "/r.json");
  assert.equal(registryPath({}, "/h"), path.join("/h", ".aify", "services.json"));
});

test("an installer runs under the chain's mark; a checkout is read back at its revision", () => {
  const runs = [];
  const run = (command, args, options) => { runs.push({ command, args, options }); return { status: 3 }; };
  assert.equal(runMarked("bash", ["/x/install.sh", "--acquire-only"], { env: { A: "1" }, run }), 3);
  assert.equal(runs[0].options.env[CHAIN_MARK], "1");
  assert.equal(runs[0].options.env.A, "1");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-git-"));
  const gits = [];
  const git = (cmd, args) => { gits.push(args[0] === "-c" ? args[2] : args[0]); return { status: 0, stdout: args[0] === "rev-parse" ? `${"e".repeat(40)}\n` : "" }; };
  const out = gitCheckout("o/r", "e".repeat(40), path.join(dir, "co"), { run: git, base: "https://github.com/" });
  assert.deepEqual(out, { ok: true, head: "e".repeat(40), problem: undefined });
  assert.deepEqual(gits, ["clone", "checkout", "rev-parse"]);
  const failing = gitCheckout("o/r", "e".repeat(40), path.join(dir, "co2"), { run: () => ({ status: 128, stderr: "no such repo" }) });
  assert.deepEqual(failing, { ok: false, problem: "no such repo" });
  assert.equal(typeof wrapperModules, "function");
});

test("a package's own assets entry runs after its connect, in assets-only mode with the url", async () => {
  const entry = { command: "/node", args: ["/pk/assets.mjs"] };
  const { io, calls } = host({ present: ["claude"], installer: null, pkgAssets: entry });
  const dash = parseChainArgs(["--connect", "aify-dashboard=http://d.test:7000", "--client", "claude", "--secret", "aify-dashboard.credentialRef=/k"]);
  const { exit } = await new InstallChain(dash, io).run();
  assert.equal(exit, EXIT_OK);
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf("packageAssets") > order.indexOf("connect"));
  assert.deepEqual(calls.find((c) => c[0] === "installer"), ["installer", entry, "--assets-only", "--client", "claude", "http://d.test:7000"]);
  const none = host({ present: ["claude"], installer: null });
  await new InstallChain(dash, none.io).run();
  assert.ok(none.io.said.includes("assets: aify-dashboard declares no assets entry"));
  const bad = host({ present: ["claude"], installer: null, pkgAssets: { problem: "two packages" } });
  const out = await new InstallChain(dash, bad.io).run();
  assert.match(out.report.problems[0], /assets entry of aify-dashboard: two packages/);
  const given = host({ present: ["claude"] });
  await new InstallChain(plan(), given.io).run();
  assert.ok(!given.calls.some((c) => c[0] === "packageAssets"), "an installer the service already has is not replaced");
});

test("a package's assets entry is the <service>-assets bin of the one package npm installed directly, beside its dependencies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-pkg-"));
  const rev = "f".repeat(40);
  const art = { id: "dashboard-bridge", kind: "package", source: { git: { repo: "o/r", revision: rev } }, entries: ["aify-dashboard-bridge"] };
  const prefix = path.join(root, "aify-dashboard", "dashboard-bridge", rev);
  let listed = { dependencies: { "@scope/aify-dashboard": { resolved: `git+ssh://git@github.com/o/r.git#${rev}` } } };
  // The aify-wrapper contract (lib/package-install.mjs installedCommit, binFiles), in miniature.
  const installedCommit = (ls) => {
    const deps = Object.entries(ls?.dependencies ?? {});
    if (deps.length !== 1) return { problem: `npm reports ${deps.length} packages in the artifact's prefix, not 1` };
    return { name: deps[0][0], commit: /#([0-9a-f]{40})$/.exec(deps[0][1].resolved)?.[1], problem: "" };
  };
  const binFiles = (pkg, entries) => {
    const file = String(pkg.bin?.[entries[0]] ?? "");
    return /(^|\/)\.\.(\/|$)|^\//.test(file) ? { files: {}, problems: [`${entries[0]}'s bin ${file} leaves the package`] } : { files: { [entries[0]]: file }, problems: [] };
  };
  const tupleDigest = (a) => `${a.kind}:${a.source.git.repo}`;
  const p = {
    fetchSpec: async () => ({ artifacts: [art] }), validateSpec: (spec) => ({ ok: true, errors: [], spec }), packageRoot: root, execPath: "/node",
    npmLs: () => listed, installedCommit, binFiles, tupleDigest, catalogue: [], approve: ["package:o/r"],
    accepted: { "dashboard-bridge": path.join(root, "aify-dashboard", "dashboard-bridge", rev, "node_modules", "@scope", "aify-dashboard").split(path.sep).join("/") },
  };
  assert.match((await packageAssets("aify-dashboard", "http://d", p)).problem, /not installed under/);
  const pkg = path.join(prefix, "node_modules", "@scope", "aify-dashboard");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(path.join(prefix, "node_modules", "a-hoisted-dependency"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "bin"));
  fs.writeFileSync(path.join(pkg, "bin", "assets.mjs"), "");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { "aify-dashboard-bridge": "bin/b.mjs" } }));
  assert.equal(await packageAssets("aify-dashboard", "http://d", p), null, "no declared entry is no assets");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { "aify-dashboard-assets": "bin/assets.mjs" } }));
  assert.deepEqual(await packageAssets("aify-dashboard", "http://d", p), { command: "/node", args: [path.join(pkg, "bin", "assets.mjs")] }, "a hoisted dependency beside it is not a second candidate");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { "aify-dashboard-assets": "../../../x.mjs" } }));
  assert.match((await packageAssets("aify-dashboard", "http://d", p)).problem, /leaves the package/);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { "aify-dashboard-assets": "bin/gone.mjs" } }));
  assert.match((await packageAssets("aify-dashboard", "http://d", p)).problem, /not on disk/);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { "aify-dashboard-assets": "bin/assets.mjs" } }));
  listed = { dependencies: { "@scope/aify-dashboard": { resolved: `git+ssh://git@github.com/o/r.git#${"e".repeat(40)}` } } };
  assert.match((await packageAssets("aify-dashboard", "http://d", p)).problem, /not the spec's revision/);
  listed = { dependencies: {} };
  assert.match((await packageAssets("aify-dashboard", "http://d", p)).problem, /npm reports 0 packages/);
  assert.match((await packageAssets("aify-dashboard", "http://d", { ...p, validateSpec: () => ({ ok: false, errors: ["name"] }) })).problem, /refused: name/);
  assert.equal(await packageAssets("aify-dashboard", "http://d", { ...p, fetchSpec: async () => ({ artifacts: [{ ...art, kind: "file-set" }] }) }), null);
});

test("assets run only from the package connect installed, at a tuple approved now: a later spec naming another repository is refused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-pkg-ab-"));
  const revA = "a".repeat(40), revB = "b".repeat(40);
  const artA = { id: "dashboard-bridge", kind: "package", source: { git: { repo: "o/r", revision: revA } }, entries: ["aify-dashboard-bridge"] };
  const artB = { id: "dashboard-bridge", kind: "package", source: { git: { repo: "evil/other", revision: revB } }, entries: ["aify-dashboard-bridge"] };
  // Both installed, each a valid package with an assets bin beside a hoisted dependency: B by an earlier, separate run.
  const install = (art, rev) => {
    const prefix = path.join(root, "aify-dashboard", art.id, rev);
    const pkg = path.join(prefix, "node_modules", "aify-dashboard");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "node_modules", "hoisted-dependency"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "bin", "assets.mjs"), "");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { "aify-dashboard-bridge": "bin/b.mjs", "aify-dashboard-assets": "bin/assets.mjs" } }));
    return { prefix, pkg, listed: { dependencies: { "aify-dashboard": { resolved: `git+ssh://git@github.com/${art.source.git.repo}.git#${rev}` } } } };
  };
  const a = install(artA, revA), b = install(artB, revB);
  const byPrefix = { [a.prefix]: a.listed, [b.prefix]: b.listed };
  const p = {
    validateSpec: (spec) => ({ ok: true, errors: [], spec }), packageRoot: root, execPath: "/node",
    npmLs: (prefix) => byPrefix[prefix], installedCommit: (ls) => {
      const [[name, dep]] = Object.entries(ls.dependencies);
      return { name, commit: /#([0-9a-f]{40})$/.exec(dep.resolved)[1], problem: "" };
    },
    binFiles: (pkg, entries) => ({ files: { [entries[0]]: pkg.bin[entries[0]] }, problems: [] }),
    tupleDigest: (art) => `${art.kind}:${art.source.git.repo}`, catalogue: [], approve: ["package:o/r"],
    // What connect reported installing in this run: A's package, nothing else.
    accepted: { "dashboard-bridge": a.pkg.split(path.sep).join("/") },
    // Registry text that must not count: a row NAMED after B's directory whose arguments run A, and a stale row a
    // differently named earlier connect left behind, pointing into B (connect's mergeEntry keeps such rows).
    registryEntry: { mcp: [
      { name: `aify-dashboard ${b.pkg.split(path.sep).join("/")}`, command: "/node", args: [`${a.pkg.split(path.sep).join("/")}/bin/b.mjs`] },
      { name: "an-older-bridge", command: "/node", args: [`${b.pkg.split(path.sep).join("/")}/bin/b.mjs`] },
    ] },
  };
  const stable = await packageAssets("aify-dashboard", "http://d", { ...p, fetchSpec: async () => ({ artifacts: [artA] }) });
  assert.deepEqual(stable, { command: "/node", args: [path.join(a.pkg, "bin", "assets.mjs")] }, "CONTROL: A, connected and approved, beside a hoisted dependency");
  const swapped = await packageAssets("aify-dashboard", "http://d", { ...p, fetchSpec: async () => ({ artifacts: [artB] }) });
  assert.match(swapped.problem ?? "", /is not approved/, "B's repository was never approved for this run, and its package ran");
  const approvedButNotConnected = await packageAssets("aify-dashboard", "http://d", { ...p, approve: ["package:o/r", "package:evil/other"], fetchSpec: async () => ({ artifacts: [artB] }) });
  assert.match(approvedButNotConnected.problem ?? "", /is not the package connect installed in this run/, "B was approved, named in a row and in a stale row, but connect installed A; B's package ran");
  const nothingAccepted = await packageAssets("aify-dashboard", "http://d", { ...p, accepted: {}, fetchSpec: async () => ({ artifacts: [artA] }) });
  assert.match(nothingAccepted.problem ?? "", /is not the package connect installed in this run/, "connect reported installing nothing, and a package ran");
});

test("an approved package without an assets bin is no assets, even with no MCP row and nothing reported for it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-pkg-plain-"));
  const rev = "c".repeat(40);
  const art = { id: "plain", kind: "package", source: { git: { repo: "o/plain", revision: rev } }, entries: ["plain-bridge"] };
  const prefix = path.join(root, "svc", "plain", rev);
  const pkg = path.join(prefix, "node_modules", "plain");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "plain", bin: { "plain-bridge": "bin/b.mjs" } }));
  const out = await packageAssets("svc", "http://s", {
    fetchSpec: async () => ({ artifacts: [art] }), validateSpec: (spec) => ({ ok: true, errors: [], spec }), packageRoot: root, execPath: "/node",
    npmLs: () => ({ dependencies: { plain: { resolved: `git+ssh://git@github.com/o/plain.git#${rev}` } } }),
    installedCommit: (ls) => ({ name: "plain", commit: /#([0-9a-f]{40})$/.exec(ls.dependencies.plain.resolved)[1], problem: "" }),
    binFiles: () => { throw new Error("binFiles was asked about a package with no assets bin"); },
    tupleDigest: () => "package:o/plain", catalogue: ["package:o/plain"], approve: [], accepted: {}, registryEntry: { mcp: [] },
  });
  assert.equal(out, null);
});

test("connect's report of what it installed this run is read line by line, and reaches the assets lookup", async () => {
  const report = [
    "connected aify-dashboard at http://d.test:7000: committed",
    "  dashboard-bridge: installed at /home/u/.aify/packages/aify-dashboard/dashboard-bridge/" + "a".repeat(40) + "/node_modules/aify-dashboard",
    "  other-pkg: already installed at C:/Users/u/.aify/packages/aify-dashboard/other-pkg/" + "b".repeat(40) + "/node_modules/@s/o",
    "  mcp aify-dashboard: no entry written -- installed at /not/a/package/line",
  ].join("\n");
  assert.deepEqual(acceptedPackages(report), {
    "dashboard-bridge": `/home/u/.aify/packages/aify-dashboard/dashboard-bridge/${"a".repeat(40)}/node_modules/aify-dashboard`,
    "other-pkg": `C:/Users/u/.aify/packages/aify-dashboard/other-pkg/${"b".repeat(40)}/node_modules/@s/o`,
  });
  const echoed = [];
  const run = () => ({ status: 0, stdout: `${report}\n` });
  const captured = runMarkedCapture("node", ["connect"], { env: {}, run, write: (t) => echoed.push(t) });
  assert.equal(captured.status, 0);
  assert.equal(captured.stdout, `${report}\n`);
  assert.deepEqual(echoed, [`${report}\n`], "the operator still sees connect's report");
  const accepted = { "dashboard-bridge": "/p/a" };
  const { io, calls } = host({ present: ["claude"], installer: null, installed: { "aify-dashboard": accepted } });
  const dash = parseChainArgs(["--connect", "aify-dashboard=http://d.test:7000", "--client", "claude", "--secret", "aify-dashboard.credentialRef=/k"]);
  await new InstallChain(dash, io).run();
  assert.deepEqual(calls.find((c) => c[0] === "packageAssets"), ["packageAssets", "aify-dashboard", accepted]);
});
