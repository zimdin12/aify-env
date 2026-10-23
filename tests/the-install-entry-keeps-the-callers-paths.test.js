// The public shell entry, `install.sh --connect ...`, changes into its own directory before it runs anything. A relative
// `--secret <svc>.<field>=<file>` or `--installer <svc>=<path>` names a file where the CALLER stands, so the entry makes
// it absolute against the caller's directory first; otherwise the chain read a different file, or none.
//
// npm and node are fakes on a PATH that holds nothing else of theirs: nothing is installed, and the fake node records
// the arguments the chain would have been started with.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toBash = (p) => p.replace(/\\/g, "/");
const BASH = spawnSync("bash", ["-c", 'p="$(command -v bash)"; cygpath -w "$p" 2>/dev/null || echo "$p"'], { encoding: "utf8" }).stdout.trim();

function entry(args, cwd) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "entry-bin-"));
  const log = toBash(path.join(bin, "node.log"));
  fs.writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "node"), `#!/usr/bin/env bash\n[ "$1" = --version ] && { echo v22.0.0; exit 0; }\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
  const run = spawnSync(BASH, [toBash(path.join(ROOT, "install.sh")), ...args], {
    cwd, encoding: "utf8", env: { PATH: `${toBash(bin)}:/usr/bin:/bin`, HOME: cwd, USERPROFILE: cwd, SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
  });
  const calls = fs.existsSync(path.join(bin, "node.log")) ? fs.readFileSync(path.join(bin, "node.log"), "utf8") : "";
  return { status: run.status, stderr: run.stderr, chain: calls.split("\n").find((l) => l.includes("aify-env-install.mjs")) ?? "" };
}

test("relative --secret and --installer paths are made absolute against the caller's directory", () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "entry-caller-"));
  const here = toBash(spawnSync(BASH, ["-c", "pwd"], { cwd: caller, encoding: "utf8" }).stdout.trim());
  const out = entry(["--connect", "aify-comms=http://c.test:8800", "--client", "claude", "--secret", "aify-comms.credentialRef=./key", "--installer", "aify-comms=sub/install.sh"], caller);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.chain, "the chain was not started");
  assert.ok(out.chain.includes(`--secret aify-comms.credentialRef=${here}/./key`), out.chain);
  assert.ok(out.chain.includes(`--installer aify-comms=${here}/sub/install.sh`), out.chain);
});

test("absolute paths, and values the chain will refuse, pass through unchanged", () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "entry-caller-"));
  const out = entry(["--connect", "aify-comms=http://c.test:8800", "--client", "claude", "--secret", "aify-comms.credentialRef=/abs/key", "--installer", "no-equals-sign"], caller);
  assert.ok(out.chain.includes("--secret aify-comms.credentialRef=/abs/key"), out.chain);
  assert.ok(out.chain.includes("--installer no-equals-sign"), out.chain);
  const windows = entry(["--connect", "aify-comms=http://c.test:8800", "--client", "claude", "--secret", "aify-comms.credentialRef=C:\\k\\key", "--installer", "aify-comms=D:/s/install.sh"], caller);
  assert.ok(windows.chain.includes("--secret aify-comms.credentialRef=C:\\k\\key"), windows.chain);
  assert.ok(windows.chain.includes("--installer aify-comms=D:/s/install.sh"), windows.chain);
});

test("an empty right-hand side reaches the chain's parser empty, and a UNC path is kept absolute", () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "entry-caller-"));
  const empty = entry(["--connect", "aify-comms=http://c.test:8800", "--client", "claude", "--secret", "aify-comms.credentialRef=", "--installer", "aify-comms="], caller);
  assert.ok(/--secret aify-comms\.credentialRef=( |$)/.test(empty.chain), `an empty key path was given a directory: ${empty.chain}`);
  assert.ok(/--installer aify-comms=( |$)/.test(empty.chain), `an empty installer path was given a directory: ${empty.chain}`);
  const unc = entry(["--connect", "aify-comms=http://c.test:8800", "--client", "claude", "--secret", "aify-comms.credentialRef=\\\\host\\share\\key", "--installer", "aify-comms=//host/share/install.sh"], caller);
  assert.ok(unc.chain.includes("--secret aify-comms.credentialRef=\\\\host\\share\\key"), `a UNC path was made relative: ${unc.chain}`);
  assert.ok(unc.chain.includes("--installer aify-comms=//host/share/install.sh"), unc.chain);
});
