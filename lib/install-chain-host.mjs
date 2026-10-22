// The install chain's ports on a real host (lib/install-chain.mjs holds the order and the rules).
//
// NOTHING HERE STARTS aify-env. The chain installs packages, runs installers and aify-wrapper's connect; the host
// tier starts only when the operator starts it. A bare `aify-env` supersedes the running one and reaps its workers.
//
// A SERVICE'S CODE RUNS ONLY FROM AN APPROVED TUPLE. Before a service's installer is fetched and run, its spec is read
// with no key (aify-wrapper's fetchSpec: no redirect followed), judged for the selected name and origin, and its
// file-set artifact's tuple must be in aify-wrapper's catalogue or approved by `--approve` (S1, "Approval"). The
// checkout is made at the artifact's exact revision and read back before anything in it runs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CHAIN_MARK } from "./install-chain.mjs";
import { CREDENTIAL_OK } from "./credential-store.mjs";
import { credentialRoot, readCredentialFile } from "./credential-fs.mjs";

const REVISION = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The registry this chain publishes into: $AIFY_SERVICE_REGISTRY, else ~/.aify/services.json. */
export function registryPath(env, home) {
  return env.AIFY_SERVICE_REGISTRY || path.join(home, ".aify", "services.json");
}

/** Whether `name` already has a published key on this host: a registry entry naming a reference the store can read. */
export async function hasPublishedKey(name, { registry, read = readCredentialFile, root = credentialRoot() }) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(registry, "utf8"))?.services?.[name];
  } catch {
    return false;
  }
  const ref = entry?.credentialRef;
  if (typeof ref !== "string" || !ref) return false;
  try {
    return (await read({ root, ref }))?.state === CREDENTIAL_OK;
  } catch {
    return false; // unreadable is not held
  }
}

/**
 * The installer of `name`'s approved git file-set artifact, checked out at its revision; null when the service has
 * none (a package artifact is installed by connect itself); `{problem}` when it may not run.
 *
 * @param {object} p
 * @param {(endpoint: string) => Promise<object>} p.fetchSpec  aify-wrapper's unauthenticated, no-redirect fetch
 * @param {Function} p.validateSpec  aify-wrapper's judge for a selected name and origin
 * @param {Function} p.tupleDigest   aify-wrapper's tuple digest
 * @param {string[]} p.catalogue     digests aify-wrapper approves without asking
 * @param {string[]} p.approve       digests the operator approved on this run
 * @param {(repo: string, revision: string, dir: string) => {ok: boolean, head?: string, problem?: string}} p.checkout
 * @param {string} p.sources         where checkouts are kept (one directory per service and revision)
 */
export async function approvedInstaller(name, endpoint, p) {
  let spec;
  try {
    spec = await p.fetchSpec(endpoint);
  } catch (error) {
    return { problem: `its spec could not be read: ${error.message}` };
  }
  const judged = p.validateSpec(spec, { name, endpoint });
  if (!judged.ok) return { problem: `its spec is refused: ${judged.errors.join("; ")}` };
  const sets = (spec.artifacts ?? []).filter((a) => a.kind === "file-set" && a.source?.git);
  if (!sets.length) return null;
  if (sets.length > 1) return { problem: "it serves more than one git file-set; the chain acquires one" };
  const artifact = sets[0];
  const { repo, revision } = artifact.source.git;
  if (!REPO.test(String(repo)) || !REVISION.test(String(revision))) return { problem: `artifact ${artifact.id} names no exact repo and 40-hex revision` };
  const digest = p.tupleDigest(artifact);
  if (!p.catalogue.includes(digest) && !p.approve.includes(digest)) {
    return { problem: `artifact ${artifact.id} (${repo}@${revision}) is not approved; to approve exactly this tuple, rerun with --approve ${digest}` };
  }
  const dir = path.join(p.sources, name, revision);
  const out = p.checkout(repo, revision, dir);
  if (!out.ok) return { problem: `checking out ${repo}@${revision} failed: ${out.problem}` };
  if (out.head !== revision) return { problem: `the checkout of ${repo} is at ${out.head}, not ${revision}` };
  const installer = path.join(dir, "install.sh");
  if (!fs.existsSync(installer)) return { problem: `${repo}@${revision} has no install.sh` };
  return { path: installer };
}

/** A git checkout of `repo` at exactly `revision` in `dir`, read back. `base` is where repos live (GitHub by default). */
export function gitCheckout(repo, revision, dir, { base = "https://github.com/", run = spawnSync } = {}) {
  const git = (args, cwd) => run("git", args, { cwd, encoding: "utf8", timeout: 300_000 });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const clone = git(["clone", "--quiet", "--no-checkout", `${base}${repo}${base.startsWith("http") ? ".git" : ""}`, dir]);
    if (clone.status !== 0) return { ok: false, problem: (clone.stderr || clone.error?.message || "git clone failed").trim() };
  }
  const checkout = git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", revision], dir);
  if (checkout.status !== 0) {
    git(["fetch", "--quiet", "origin", revision], dir);
    const again = git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", revision], dir);
    if (again.status !== 0) return { ok: false, problem: (again.stderr || "git checkout failed").trim() };
  }
  const head = git(["rev-parse", "HEAD"], dir);
  return { ok: head.status === 0, head: String(head.stdout ?? "").trim(), problem: head.stderr };
}

/**
 * The assets entry a package artifact declares: the bin named `<service>-assets` in the package connect installed in
 * the prefix `<packageRoot>/<name>/<artifact id>/<revision>`. The package is the one npm lists there at depth 0, at the
 * spec's revision, read with aify-wrapper's own `installedCommit` and `binFiles` (lib/package-install.mjs), so its
 * hoisted dependencies are never candidates. Null when no package declares one.
 */
export async function packageAssets(name, endpoint, {
  fetchSpec, validateSpec, packageRoot, execPath = process.execPath, npmLs, installedCommit, binFiles,
  tupleDigest, catalogue = [], approve = [], registryEntry,
}) {
  let spec;
  try {
    spec = await fetchSpec(endpoint);
  } catch (error) {
    return { problem: `its spec could not be read: ${error.message}` };
  }
  const judged = validateSpec(spec, { name, endpoint });
  if (!judged.ok) return { problem: `its spec is refused: ${judged.errors.join("; ")}` };
  const entry = `${name}-assets`;
  for (const artifact of spec.artifacts ?? []) {
    if (artifact.kind !== "package" || !artifact.source?.git) continue;
    const revision = String(artifact.source.git.revision);
    const prefix = path.join(packageRoot, name, String(artifact.id), revision);
    if (!fs.existsSync(path.join(prefix, "node_modules"))) return { problem: `${artifact.id} is not installed under ${prefix}` };
    let installed;
    try {
      installed = installedCommit(npmLs(prefix));
    } catch (error) {
      return { problem: `${artifact.id}: npm could not list ${prefix}: ${error.message}` };
    }
    if (installed.problem) return { problem: `${artifact.id}: ${installed.problem}` };
    if (installed.commit !== revision) return { problem: `${artifact.id}: npm reports ${installed.commit}, not the spec's revision ${revision}` };
    // BOUND TO WHAT CONNECT ACCEPTED. The spec is read again here, so its package must be one this run approves now
    // (the catalogue, or --approve), and the very package connect published: its directory is in the entry connect wrote.
    // A later answer naming another repository, with that package already on disk from an earlier run, runs nothing.
    const digest = tupleDigest(artifact);
    if (!catalogue.includes(digest) && !approve.includes(digest)) return { problem: `${artifact.id} (${artifact.source.git.repo}) is not approved for this run` };
    const dir = path.join(prefix, "node_modules", installed.name);
    if (!JSON.stringify(registryEntry?.mcp ?? []).includes(dir.split(path.sep).join("/"))) {
      return { problem: `${artifact.id}: ${dir} is not the package connect installed for ${name}` };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (!pkg.bin || typeof pkg.bin !== "object" || !(entry in pkg.bin)) continue;
    const { files, problems } = binFiles(pkg, [entry]);
    if (problems.length) return { problem: problems.join("; ") };
    const file = path.join(dir, files[entry]);
    if (!fs.existsSync(file)) return { problem: `${entry}'s bin ${files[entry]} is not on disk in ${installed.name}` };
    return { command: execPath, args: [file] };
  }
  return null;
}

/** The key variables the named services declare (`keyEnv`) in the registry connect wrote. Throws on a registry it cannot parse. */
export function registryKeyEnv(registry, names) {
  const services = JSON.parse(fs.readFileSync(registry, "utf8"))?.services ?? {};
  return names.flatMap((name) => (Array.isArray(services[name]?.keyEnv) ? services[name].keyEnv.map(String) : []));
}

/** `env` without the named variables, matched whatever their case, as Windows reads names. */
export function envWithout(env, names) {
  const drop = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key.toUpperCase())));
}

/**
 * Run a child with the chain's mark, so it can never hand back to the chain. Resolves to its exit status. `quiet`: it
 * may not ask, so stdin is closed and the installers' no-prompt contract (AIFY_NO_PROMPT=1) is set.
 */
export function runMarked(command, args, { env, run = spawnSync, input, quiet = false } = {}) {
  const stdin = quiet ? "ignore" : input === undefined ? "inherit" : "pipe";
  const result = run(command, args, { stdio: [stdin, "inherit", "inherit"], input: quiet ? undefined : input, env: { ...env, ...(quiet ? { AIFY_NO_PROMPT: "1" } : {}), [CHAIN_MARK]: "1" } });
  return result.status ?? 1;
}

/**
 * aify-wrapper's modules from its global install, loaded by path (never from this package); `{problem}` naming the
 * first one an installed or linked wrapper lacks, with what to do. A developer's link is never replaced here.
 */
export async function wrapperModules(wrapperRoot) {
  const update = "update it with npm install -g github:zimdin12/aify-wrapper, or git pull in a linked checkout";
  const out = {};
  for (const [rel, names] of Object.entries(WRAPPER_INTERFACE)) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(wrapperRoot, rel)).href);
    } catch (error) {
      return { problem: `the installed aify-wrapper at ${wrapperRoot} lacks ${rel} (${error.code ?? error.message}); ${update}` };
    }
    for (const name of names) {
      if (typeof mod[name] !== "function") return { problem: `the installed aify-wrapper at ${wrapperRoot}: ${rel} does not export ${name}; ${update}` };
      out[name] = mod[name];
    }
  }
  let catalogue;
  try {
    catalogue = JSON.parse(fs.readFileSync(path.join(wrapperRoot, "lib", "artifact-catalogue.json"), "utf8")).approved;
  } catch (error) {
    return { problem: `the installed aify-wrapper at ${wrapperRoot} lacks lib/artifact-catalogue.json (${error.code ?? error.message}); ${update}` };
  }
  if (!Array.isArray(catalogue) || !catalogue.every((d) => typeof d === "string")) {
    return { problem: `the installed aify-wrapper at ${wrapperRoot}: lib/artifact-catalogue.json holds no approved list; ${update}` };
  }
  return { ...out, catalogue };
}

/** Every aify-wrapper function the chain calls, by module: the interface a usable wrapper has, checked by name. */
const WRAPPER_INTERFACE = {
  "lib/connect-http.mjs": ["fetchSpec"],
  "lib/service-spec.mjs": ["validateSpec", "tupleDigest"],
  "lib/path-lookup.mjs": ["resolveOnPath"],
  "lib/package-install.mjs": ["installedCommit", "binFiles", "npmTool", "npmCliBeside"],
};
