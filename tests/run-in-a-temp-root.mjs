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
const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root };

const files = fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));

// THE TIMEOUT IS LOAD-BEARING and is kept here verbatim. Without it a hang in this suite once left
// a test process and two daemons alive for two and a half hours; a runner that dropped the flag
// would reintroduce that while looking like a pure refactor.
const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...files], { env, stdio: 'inherit' });

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
