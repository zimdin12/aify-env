// The environment a test may spawn the doctor with: a home of its own.
//
// THE DOCTOR READS THE HOST. Since 0.9.7 it ages the claude login in `~/.claude/.credentials.json`, and
// it always read `~/.aify` (the credential store, agent definitions, herdr receipts). A test that
// spawned it with the operator's home read the operator's login, so its rows -- and with `--strict`
// its exit code -- changed the day that login neared expiry. That is a test of the host, not the code.
//
// `os.homedir()` follows USERPROFILE on Windows and HOME elsewhere, so pointing both at a fresh temp
// directory moves every home-derived read the doctor makes. A test that wants a claude login puts a
// fixture at `<home>/.claude/.credentials.json` (`writeClaudeLogin`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

/** A fresh, empty home directory. */
export function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-doctor-home-"));
}

/** Write a claude credentials fixture under `home`, holding only the two stamps the row reads. */
export function writeClaudeLogin(home, { refreshTokenExpiresAt, expiresAt = refreshTokenExpiresAt }) {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-not-a-token", refreshToken: "fixture-not-a-token", expiresAt, refreshTokenExpiresAt },
  }));
}

/** The two variables `os.homedir()` reads, pointed at `home`. */
export function ownHome(home = freshHome()) {
  return { HOME: home, USERPROFILE: home };
}

/** `sealedDaemonEnv` plus a home of the test's own. `extra` is applied last. */
export function sealedDoctorEnv(extra = {}, { home = freshHome() } = {}) {
  return { ...sealedDaemonEnv(), ...ownHome(home), ...extra };
}
