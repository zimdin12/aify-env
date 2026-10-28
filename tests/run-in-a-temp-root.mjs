// Run the suite with TEMP pointed at ONE directory, then delete that directory.
//
// THE LEAK THIS ENDS. Every test that needs a scratch directory calls `mkdtemp` and most never
// remove it, because a test that fails mid-way never reaches its own cleanup. Measured across this
// machine on 2026-09-02: 148 `aify-*` directories in the user's Temp from a single morning of suite
// runs, and roughly 50,000 before a disk-cleanup tool removed them. The prefixes name test scenarios
// -- `aify-damaged`, `aify-reinstall`, `aify-cwd` -- so this was never a shipped code path; it is
// test hygiene, and it filled a disk anyway.
//
// WHY REDIRECT TEMP RATHER THAN FIX EACH TEST. `os.tmpdir()` reads TMPDIR/TEMP/TMP at CALL time, so
// setting them here puts every `mkdtemp` inside this root -- in this process, in every test file, and
// in every child process any test spawns, including the launchers and daemons these tests start.
// Nothing in a test file changes, and forgetting to clean up stops mattering. Fixing the calls one
// by one would fix only the ones somebody remembered, and only until the next test is written.
//
// OLD ROOTS ARE PRUNED because a crashed or killed run never reaches its own teardown -- which is
// exactly the case that produced the pile. An hour is longer than any run here and short enough that
// a forgotten root does not survive the day.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIFETIME_CARRIERS } from '../lib/managed-lifetimes.mjs';

const PREFIX = 'aify-env-testrun-';
const PRUNE_AFTER_MS = 60 * 60 * 1000;

/** Remove roots left by runs that never reached their own teardown. */
function pruneOldRoots(parent) {
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const full = path.join(parent, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // A root another run still holds, or one the OS will not let us touch. Skipping it is right:
      // pruning is a courtesy, and failing here must never fail the suite.
    }
  }
}

const parent = os.tmpdir();
pruneOldRoots(parent);

const root = fs.mkdtempSync(path.join(parent, PREFIX));

// All three, because which one is read depends on the platform: TMPDIR on POSIX, TEMP and TMP on
// Windows. Setting one and not the others leaves the leak in place on the other platform, silently.
// THE HOST SECRET TOO (lib/host-secret.mjs): a plugin or a daemon that sends a proof makes it on first use,
// and a full run made the operator's real ~/.aify/host-secret on 2026-10-03 before this line existed.
// NOR THE HERDR OR AGENT OF THE TERMINAL IT WAS STARTED FROM (2026-10-03): run from an agent's Herdr pane, tests
// inherited that pane's live socket and that agent's id and lease. aify-wrapper's runner drops the same (its
// lib/inherited-session.mjs holds the full session list; these are the names that make a process an agent).
// NOR ITS LIFETIME (2026-10-28): a single-file run from a managed agent's pane carried that agent's AIFY_LIFETIME,
// AIFY_ENV_INSTANCE and AIFY_ENV_URL, which are what a managed child uses to speak as that lifetime to the live host.
// Taken from the Runner's own list, so a new carrier is dropped here without an edit.
const dropped = new Set(['AIFY_AGENT_ID', 'AIFY_AGENT_LEASE', 'CLAUDE_CODE_CHILD_SESSION', ...LIFETIME_CARRIERS]);
const inherited = { ...process.env };
for (const name of Object.keys(inherited)) {
  if (/^(AIFY_)?HERDR_/i.test(name) || dropped.has(name.toUpperCase())) delete inherited[name];
}
// Daemon boot now writes descriptor/generation/turns under homedir(), so tests must own that home too.
const home = path.join(root, 'home');
fs.mkdirSync(home);
// AND THE SERVICE REGISTRY (review of B1, 2026-10-17). A private HOME does not fence an absolute AIFY_SERVICE_REGISTRY
// the starting shell set, and advertising off is not plugin startup off: a daemon started under it read that registry
// and started its plugins against the services it named. The suite's registry is a path in this root that no file is
// at; a test that needs a registry names its own.
const env = { ...inherited, HOME: home, USERPROFILE: home, TMPDIR: root, TEMP: root, TMP: root, AIFY_HOST_SECRET_FILE: path.join(root, 'host-secret'),
  AIFY_SERVICE_REGISTRY: path.join(root, 'no-such-services.json') };

// FILES NAMED ON THE COMMAND LINE run alone, under the same root (`npm test -- tests/x.test.js`). A targeted run
// started as `node --test tests/x.test.js` gets none of the above: on 2026-10-20 this host's Temp held about 2,200
// fixture directories from such runs, 218 of them from one file in one day, while every full run left nothing.
const named = process.argv.slice(2);
const files = named.length > 0 ? named : fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));

// THE TIMEOUT IS LOAD-BEARING and is kept here verbatim. Without it a hang in this suite once left
// a test process and two daemons alive for two and a half hours; a runner that dropped the flag
// would reintroduce that while looking like a pure refactor.
//
// 180 s, NOT 60 (2026-10-03). It bounds a HANG, which it still does, and is not a speed budget. On this shared
// host a git-heavy file that passes in 31 s alone crossed 60 s under other sessions' load and was cancelled,
// while the same commit's next run passed with its slowest file at 40.6 s. The cancellations followed the
// host's load (59% then 41%), which is a correlation observed twice, not a proof that load was the only cause.
// Splitting files only moved that edge.
//
// 600 s, NOT 180 (2026-10-22). The flag bounds each FILE as a whole, not each test: under process isolation the
// file is itself a test, so the bound covers the SUM of its tests (node 22.20, measured: three 1.5 s tests under a
// 2.5 s bound fail the file). In six sequential full runs on main ed9ebe5, the git-heavy
// the-dashboard-plugin-reads-no-object-store-out-of-the-grant.test.js summed 85.8 to 175.6 s in the runs it passed
// and was cancelled at 180 s in the other two; the-dashboard-plugin-reports-commits.test.js reached 164.9 s and was
// cancelled once. That is a bound at its own normal cost, not above a hang. 600 s is 3.4 times the slowest passing
// file measured and still ends a hang in minutes, not hours.
const child = spawn(process.execPath, ['--test', '--test-timeout=600000', ...files], { env, stdio: 'inherit' });

child.on('exit', (code, signal) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Leave it for the prune above on the next run rather than masking the suite's own result.
  }
  // THE SUITE'S EXIT STATUS, not this wrapper's. A runner that swallowed a failure would turn a red
  // suite green, which is worse than the leak it was written to fix.
  process.exit(signal ? 1 : (code ?? 1));
});
