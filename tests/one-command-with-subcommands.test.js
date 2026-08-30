// One command on PATH, with subcommands. Not three binaries.
//
// The operator's target: the host tier is `aify-env`, its doctor is `aify-env doctor`, and its TUI is
// `aify-env tui`. Three separate binaries for one product is what caused the `aify-doctor` collision
// with aify-comms in the first place, and a name collision is only the loud version of the problem --
// the quiet one is a reader having to know which of three commands answers their question.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = () => JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ENTRY = path.join(ROOT, "bin", "aify-env.mjs");

const run = (args, env = {}) => spawnSync(process.execPath, [ENTRY, ...args], {
  encoding: "utf8", timeout: 30_000, env: sealedDaemonEnv(env),
});

test("exactly one command is published", () => {
  const bins = Object.keys(manifest().bin ?? {});
  assert.deepEqual(bins, ["aify-env"], (
    `one product, one command. Extra binaries here: ${bins.filter((b) => b !== "aify-env")}`
  ));
});

test("`aify-env doctor` runs the doctor", () => {
  // Pointed at nothing, so it exercises the unreachable path rather than the operator's daemon.
  const r = run(["doctor"], { AIFY_ENV_ENDPOINT: "http://127.0.0.2:1" });
  assert.equal(r.status, 0, `doctor should exit 0 without --strict: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /environment/, "it must render the environment check");
  assert.match(r.stdout + r.stderr, /unanswered|failed/, "and say what it could not determine");
});

test("`aify-env doctor --strict` still acts on the answer", () => {
  const r = run(["doctor", "--strict"], { AIFY_ENV_ENDPOINT: "http://127.0.0.2:1" });
  assert.notEqual(r.status, 0, "--strict must exit non-zero when something failed or went unanswered");
});

test("`aify-env doctor --json` is still machine-readable", () => {
  const r = run(["doctor", "--json"], { AIFY_ENV_ENDPOINT: "http://127.0.0.2:1" });
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.checks) && parsed.checks.length, "checks must survive the move");
});

test("an unknown subcommand says so instead of silently starting a daemon", () => {
  // The dangerous failure: `aify-env doctr` typo'd into starting the environment.
  const r = run(["doctr"]);
  assert.notEqual(r.status, 0, "an unknown subcommand must not fall through to starting the daemon");
  assert.match(r.stderr + r.stdout, /doctr/, "and it must name what it did not understand");
});

test("the old binaries are gone from the package", () => {
  const bins = manifest().bin ?? {};
  assert.equal("aify-env-doctor" in bins, false, "the separate doctor binary is retired");
  assert.equal("aify-env-tui" in bins, false, "the separate tui binary is retired");
});
