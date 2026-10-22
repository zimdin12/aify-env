#!/usr/bin/env node
// `aify-env install`: the guided-install chain (lib/install-chain.mjs holds its order and rules). This file supplies the
// host -- argv, stdin, npm, git, aify-wrapper's connect and installer -- and starts nothing: the host tier starts only
// when the operator starts `aify-env`.
//
//   aify-env install --connect aify-comms=http://host:8800 --client claude --secret aify-comms.credentialRef=<file>
//
// Exit codes: 0 complete, 78 refused or incomplete (each problem and pending client is named). Set as exitCode, never by
// process.exit(): the dispatcher (bin/aify-env.mjs) flushes stdout before it exits, and a pipe would lose the report.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { InstallChain, USAGE, parseChainArgs } from "../lib/install-chain.mjs";
import { resolveExecutable } from "../lib/interpreter.mjs";
import { approvedInstaller, gitCheckout, hasPublishedKey, packageAssets, registryPath, runMarked, wrapperModules } from "../lib/install-chain-host.mjs";

const plan = parseChainArgs(process.argv.slice(2));
if (plan.problem) process.stderr.write(`aify-env install: ${plan.problem}\n${USAGE}\n`);
process.exitCode = plan.problem ? 78 : await runChain(plan);

/** The chain on this host; resolves to its exit status. */
async function runChain(plan) {
  const env = process.env;
  const home = os.homedir();
  const registry = registryPath(env, home);
  const windows = process.platform === "win32";
  // Git Bash by its path: a bare `bash` on Windows can be WSL's, which cannot open a C: path (lib/interpreter.mjs).
  const bash = resolveExecutable("bash");
  const say = (line) => process.stdout.write(`[aify-env] ${line}\n`);
  const stdinKey = plan.secretStdin ? fs.readFileSync(0, "utf8") : undefined;

  function npmRoot() {
    const run = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: windows, timeout: 60_000 });
    return run.status === 0 ? run.stdout.trim() : "";
  }
  const root = npmRoot();
  const wrapperRoot = path.join(root, "aify-wrapper");
  // Where aify-wrapper comes from when it is missing: its git form (TARGET_ARCHITECTURE), or a package spec a test names.
  const wrapperSource = env.AIFY_INSTALL_WRAPPER_SOURCE || "github:zimdin12/aify-wrapper";
  let wrapper = null;

  const io = {
    env,
    say,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(question); } finally { rl.close(); }
    },
    publishedKey: (name) => hasPublishedKey(name, { registry }),
    ensurePackages: async () => {
      if (!fs.existsSync(path.join(wrapperRoot, "package.json"))) {
        say(`installing aify-wrapper (${wrapperSource})`);
        const npm = spawnSync("npm", ["install", "-g", "--no-audit", "--no-fund", wrapperSource], { stdio: "inherit", shell: windows });
        if (npm.status !== 0) return false;
      }
      wrapper = await wrapperModules(wrapperRoot);
      return true;
    },
    approvedInstaller: (name, url, approve) => approvedInstaller(name, url, {
      ...wrapper, approve,
      checkout: (repo, revision, dir) => gitCheckout(repo, revision, dir, { base: env.AIFY_INSTALL_GIT_BASE || undefined }),
      sources: path.join(path.dirname(registry), "sources"),
    }),
    // An install.sh runs under bash; a package's assets entry is `{command, args}`.
    runInstaller: (installer, args) => (typeof installer === "string"
      ? runMarked(bash, [installer, ...args], { env })
      : runMarked(installer.command, [...installer.args, ...args], { env })),
    packageAssets: (name, url) => packageAssets(name, url, { ...wrapper, packageRoot: path.join(home, ".aify", "packages") }),
    connect: ({ name, url, keys, stdin, approve, noPrompt }) => {
      const args = [path.join(wrapperRoot, "bin", "aify-wrapper-connect.mjs"), name, url, "--registry", registry];
      for (const key of keys) args.push(...(key.field === "credentialRef" ? ["--key-file", key.file] : ["--secret-file", `${key.field}=${key.file}`]));
      if (stdin?.field === "credentialRef") args.push("--key-stdin");
      for (const digest of approve) args.push("--approve", digest);
      if (noPrompt) args.push("--no-prompt");
      if (stdin && stdin.field !== "credentialRef") {
        // connect reads only the service key from stdin; any other field goes through a private file.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-env-install-"));
        const file = path.join(dir, stdin.field);
        fs.writeFileSync(file, stdinKey, { mode: 0o600 });
        args.push("--secret-file", `${stdin.field}=${file}`);
        try { return runMarked(process.execPath, args, { env }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      return runMarked(process.execPath, args, { env, input: stdin ? stdinKey : undefined });
    },
    render: (client, url) => runMarked(bash, [path.join(wrapperRoot, "install.sh"), "--client", client, "--endpoint", url, "--registry", registry], { env }),
    registryHash: () => {
      try { return createHash("sha256").update(fs.readFileSync(registry)).digest("hex"); } catch { return "absent"; }
    },
    cliPresent: (client) => wrapper.resolveOnPath(client, { env }).ok === true,
  };
  const { exit } = await new InstallChain(plan, io).run();
  return exit;
}
