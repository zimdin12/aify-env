// The environment a test daemon may be started with.
//
// ADVERTISING IS ON BY DEFAULT SINCE 2026-08-30, which is correct for a real host and wrong for a
// test. A daemon spawned by a test inherits the machine's real `~/.aify/services.json`, finds the
// operator's aify-comms in it, and posts this host's runtimes and terminal state to the LIVE service
// -- describing a host from a process that exists for two seconds.
//
// THAT IS NOT HYPOTHETICAL IN THIS PROJECT. A "hostile environment" suite run once pointed at the
// operator's real service and registered six agents into their production registry, and a test that
// set an ACTION flag rather than a config one became the environment bridge and reaped seven live
// gateway hosts. A test may set a variable that says where to look; it must not set one that makes
// something happen.
//
// SEALED, NOT REDIRECTED. `AIFY_ADVERTISE=0` says "this daemon describes nobody", which is the honest
// state for a process that is about to be killed. A test that is ABOUT advertising points
// `AIFY_SERVICE_REGISTRY` at a fake service instead and turns it back on deliberately -- see
// `the-daemon-really-advertises.test.js`.

/**
 * `process.env` plus the seals every spawned daemon needs, and nothing else.
 *
 * @param {object} [extra] per-test additions, applied last so a test can deliberately re-enable
 */
export function sealedDaemonEnv(extra = {}) {
  return {
    ...process.env,
    // Say nothing to anyone. A test daemon has no host to describe.
    AIFY_ADVERTISE: "0",
    // And if a test turns advertising back on, it must also say WHERE -- an empty registry path
    // resolves to nothing readable rather than to the operator's real one.
    AIFY_SERVICE_REGISTRY: process.env.AIFY_SERVICE_REGISTRY ?? "",
    // The view writes escapes into captured output and slows every assertion that reads it.
    AIFY_NO_DASHBOARD: "1",
    ...extra,
  };
}
