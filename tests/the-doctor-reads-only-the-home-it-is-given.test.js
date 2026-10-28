// A spawned doctor reads the home the test gives it, and never the operator's.
//
// Since 0.9.7 `aify-env doctor` ages the claude login in `~/.claude/.credentials.json`. A test that let
// it read the operator's file would change its rows -- and with `--strict` its exit code -- the day
// that login nears expiry. The seal is `sealedDoctorEnv` (_sealed-doctor-env.mjs): HOME and USERPROFILE
// at a fresh temp directory. This file proves it three ways:
//   - each claude-login code comes from a FIXTURE: ok, expiring, expired, and absent -> skipped;
//   - a read probe preloaded into the doctor (_home-read-probe.mjs) records nothing under the real
//     home's `.claude` and `.aify` -- and, as its control, records the fixture read under a temp home;
//   - every test file that spawns the doctor uses the seal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { freshHome, sealedDoctorEnv, writeClaudeLogin } from "./_sealed-doctor-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(HERE, "..", "bin", "aify-env-doctor.mjs");
const PROBE = pathToFileURL(path.join(HERE, "_home-read-probe.mjs")).href;
const NOWHERE = "http://127.0.0.2:1";
const HOUR = 3_600_000;

/**
 * `env` with PATH stripped of every directory holding a claude-aify launcher, and `launcherDir` first when given.
 * claude-aify on PATH means this host offers claude, which the claude-login row reads, so the operator's own
 * launcher must not decide a sealed doctor's row. One PATH key: Windows spells it Path, and two would race.
 */
function withLaunchers(env, launcherDir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  const kept = String(env[key] ?? "").split(path.delimiter).filter((dir) => {
    try { return !fs.readdirSync(dir).some((name) => name.startsWith("claude-aify")); } catch { return true; }
  });
  const sealed = { ...env };
  for (const name of Object.keys(sealed)) if (name.toUpperCase() === "PATH") delete sealed[name];
  return { ...sealed, PATH: [launcherDir, ...kept].filter(Boolean).join(path.delimiter) };
}

/** A directory holding a claude-aify launcher that carries the wrapper marker, and nothing that runs. */
function claudeLauncherDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doctor-launcher-"));
  fs.writeFileSync(path.join(dir, "claude-aify"), '#!/bin/sh\nHARNESS_WRAPPER_VERSION="1"\nexit 64\n');
  return dir;
}

/** Run the doctor sealed into `home`, optionally recording reads under `watch`. */
function doctor(home, { watch = [], launcherDir = "" } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-doctor-seal-"));
  const log = path.join(scratch, "reads.log");
  fs.writeFileSync(log, "");
  const res = spawnSync(process.execPath, ["--import", PROBE, DOCTOR, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: withLaunchers(sealedDoctorEnv({
      AIFY_SERVICE_REGISTRY: path.join(scratch, "no-registry.json"),
      AIFY_ENV_ENDPOINT: NOWHERE,
      AIFY_PROBE_TIMEOUT_MS: "300",
      AIFY_TEST_WATCH_DIRS: watch.join(path.delimiter),
      AIFY_TEST_WATCH_LOG: log,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    }, { home }), launcherDir),
  });
  assert.equal(res.status, 0, `the doctor did not run: ${res.stderr}`);
  const reads = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { row: JSON.parse(res.stdout).checks.find((check) => check.id === "claude-login"), reads };
}

test("each claude-login code comes from the fixture in the home it is given", () => {
  const now = Date.now();
  for (const [stamp, code, state] of [
    [now + 240 * HOUR, "ok", "passed"],
    [now + 10 * HOUR, "expiring", "failed"],
    [now - 3 * HOUR, "expired", "failed"],
  ]) {
    const home = freshHome();
    writeClaudeLogin(home, { refreshTokenExpiresAt: stamp });
    const { row } = doctor(home);
    assert.equal(row.code, code, `fixture expiring at ${new Date(stamp).toISOString()}: ${row.detail}`);
    assert.equal(row.state, state);
  }
  // ABSENT: a home with no claude login and no claude agent is not applicable here, whatever the operator's
  // login holds. Asking found no definitions store, and the doctor made none.
  const home = freshHome();
  const { row } = doctor(home);
  assert.equal(row.code, "skipped");
  assert.match(row.detail, /no claude credentials/);
  assert.ok(!fs.existsSync(path.join(home, ".aify", "agent-definitions")), "the doctor made a definitions store");
});

test("a claude agent defined in a home where claude was never set up fails the row", async () => {
  // The 2026-10-28 work-PC rehearsal: this row passed while a managed claude sat on its first screen.
  const home = freshHome();
  const store = new DefinitionStore({ dir: path.join(home, ".aify", "agent-definitions") });
  await store.set("probe", { id: "probe", name: "probe", role: "worker", harness: "claude", mode: "managed", workspace: home,
    model: "", effort: "", instructions: "", env: {}, herdrSpace: false }, { installed: new Set(["claude"]) });
  const { row } = doctor(home);
  assert.equal(row.code, "not-set-up", row.detail);
  assert.equal(row.state, "failed");
  assert.match(row.detail, /\(probe\)/);
});

test("claude-aify on PATH with claude never set up fails the row, with no definition at all", () => {
  // The rehearsal's own case: its agent was an ad-hoc `aify-env run --launcher claude-aify`, defined nowhere.
  const { row } = doctor(freshHome(), { launcherDir: claudeLauncherDir() });
  assert.equal(row.code, "not-set-up", row.detail);
  assert.match(row.detail, /claude-aify is installed/);
});

test("CONTROL: the probe records the credentials read under the home it watches", () => {
  // Without this the seal test below could pass on a probe that records nothing at all.
  const home = freshHome();
  writeClaudeLogin(home, { refreshTokenExpiresAt: Date.now() + 240 * HOUR });
  const { reads } = doctor(home, { watch: [path.join(home, ".claude")] });
  const expected = path.join(home, ".claude", ".credentials.json").toLowerCase();
  assert.ok(reads.includes(expected), `the probe saw none of the doctor's reads under ${home}: ${reads.join(", ")}`);
});

test("SEALED: the doctor reads nothing under the real home's .claude or .aify", () => {
  const real = os.homedir();
  const { row, reads } = doctor(freshHome(), { watch: [path.join(real, ".claude"), path.join(real, ".aify")] });
  assert.deepEqual(reads, [], `a sealed doctor read the operator's own files: ${reads.join(", ")}`);
  assert.equal(row.code, "skipped", "the row was answered from a login the sealed home does not hold");
});

test("every test that spawns the doctor gives it a home of its own", () => {
  // DERIVED, not listed: a file that spawns the doctor -- the script, or `aify-env doctor` -- and does
  // not use the seal would read the operator's login again.
  const files = fs.readdirSync(HERE).filter((name) => name.endsWith(".test.js"));
  const spawning = files.filter((name) => {
    const text = fs.readFileSync(path.join(HERE, name), "utf8");
    return /spawn(Sync)?\(/.test(text) && (/aify-env-doctor\.mjs"\)/.test(text) || /\["doctor"/.test(text));
  });
  // CONTROL: the three known spawners are found, so an empty scan cannot pass.
  for (const known of ["doctor-cli.test.js", "doctor-live.test.js", "one-command-with-subcommands.test.js"]) {
    assert.ok(spawning.includes(known), `the scan missed ${known}: ${spawning.join(", ")}`);
  }
  const unsealed = spawning.filter((name) => {
    const text = fs.readFileSync(path.join(HERE, name), "utf8");
    return !text.includes("sealedDoctorEnv(") && !text.includes("ownHome(");
  });
  assert.deepEqual(unsealed, [], "these spawn the doctor with the operator's home");
});
