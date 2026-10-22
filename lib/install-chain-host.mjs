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
 * The assets entry a package artifact declares: the bin named `<name>-assets` in the package connect installed at
 * `<packageRoot>/<name>/<artifact id>/<revision>/node_modules/<package>`. Null when no package declares one.
 */
export async function packageAssets(name, endpoint, { fetchSpec, validateSpec, packageRoot, execPath = process.execPath }) {
  let spec;
  try {
    spec = await fetchSpec(endpoint);
  } catch (error) {
    return { problem: `its spec could not be read: ${error.message}` };
  }
  const judged = validateSpec(spec, { name, endpoint });
  if (!judged.ok) return { problem: `its spec is refused: ${judged.errors.join("; ")}` };
  for (const artifact of spec.artifacts ?? []) {
    if (artifact.kind !== "package" || !artifact.source?.git) continue;
    const modules = path.join(packageRoot, name, String(artifact.id), String(artifact.source.git.revision), "node_modules");
    let names = [];
    try {
      names = fs.readdirSync(modules).flatMap((n) => (n.startsWith("@") ? fs.readdirSync(path.join(modules, n)).map((m) => `${n}/${m}`) : [n])).filter((n) => !n.startsWith("."));
    } catch {
      return { problem: `${artifact.id} is not installed under ${modules}` };
    }
    if (names.length !== 1) return { problem: `${modules} holds ${names.length} packages, not 1` };
    const dir = path.join(modules, names[0]);
    const bin = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).bin?.[`${name}-assets`];
    if (!bin) continue;
    const file = path.resolve(dir, bin);
    if (path.relative(dir, file).startsWith("..")) return { problem: `${name}-assets resolves outside its package` };
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

/** Run a bash installer with the chain's mark, so it can never hand back to the chain. Resolves to its exit status. */
export function runMarked(command, args, { env, run = spawnSync, input } = {}) {
  const result = run(command, args, { stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], input, env: { ...env, [CHAIN_MARK]: "1" } });
  return result.status ?? 1;
}

/** aify-wrapper's modules from its global install, loaded by path (never from this package). */
export async function wrapperModules(wrapperRoot) {
  const load = (rel) => import(pathToFileURL(path.join(wrapperRoot, rel)).href);
  const [http, spec, lookup] = await Promise.all([load("lib/connect-http.mjs"), load("lib/service-spec.mjs"), load("lib/path-lookup.mjs")]);
  const catalogue = JSON.parse(fs.readFileSync(path.join(wrapperRoot, "lib", "artifact-catalogue.json"), "utf8")).approved ?? [];
  return { fetchSpec: http.fetchSpec, validateSpec: spec.validateSpec, tupleDigest: spec.tupleDigest, resolveOnPath: lookup.resolveOnPath, catalogue };
}
