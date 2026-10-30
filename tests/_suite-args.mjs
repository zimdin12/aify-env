// The `node --test` arguments tests/run-in-a-temp-root.mjs starts the suite with: its own module, so a test can read
// the argv the runner will use without starting a suite.
//
// AT MOST FOUR FILES AT ONCE by default (2026-10-30). Without a bound Node 22 runs availableParallelism - 1 files at
// once, 31 on this 32-thread host, each free to start daemons, git and node children, on a host three teams share for
// their tests and builds. AIFY_TEST_CONCURRENCY sets another bound; a value that is not a whole number of 1 or more is
// refused rather than read as the default, so a typo cannot quietly put the suite back on every core.
//
// THE TIMEOUT IS LOAD-BEARING (see the runner): it ends a hang, and a list that dropped it would bring the
// two-and-a-half-hour leftover daemons back while looking like a pure refactor.

export const DEFAULT_CONCURRENCY = 4;

/**
 * @param {string[]} files  the test files to run
 * @param {Record<string, string|undefined>} env  where AIFY_TEST_CONCURRENCY is read
 * @returns {string[]} the arguments after the node binary
 */
export function suiteArgs(files, env = process.env) {
  const asked = env.AIFY_TEST_CONCURRENCY;
  const concurrency = asked === undefined || asked === '' ? DEFAULT_CONCURRENCY : Number(asked);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`AIFY_TEST_CONCURRENCY must be a whole number of 1 or more, not ${JSON.stringify(asked)}`);
  }
  return ['--test', '--test-timeout=600000', `--test-concurrency=${concurrency}`, ...files];
}
