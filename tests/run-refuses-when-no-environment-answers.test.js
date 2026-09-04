// `aify-env run` must FAIL when no environment is running, and must never start one.
//
// WHY THIS MATTERS MORE THAN AN ORDINARY EXIT CODE. `aify-env run` is what `<wrapper> --shared`
// executes: the wrapper hands its own command line to the host tier so the session outlives the
// terminal. The wrapper `exec`s it, so this process's exit status IS the wrapper's. If a missing
// environment reported success, `claude-aify --shared` would exit 0 having started nothing -- a
// silent no-op on the one feature whose entire promise is that the process keeps running after you
// close the window. The operator would be told it worked and find nothing there.
//
// FOUND BY MUTATION, 2026-09-04, and it was not covered. Changing the no-environment branch from
// `process.exit(69)` to `process.exit(0)` left the whole suite green -- 1091 tests, zero failures.
// The refusal was correct and unprotected.
//
// AND IT MUST NOT START ONE. That is the harder half. Starting an environment supersedes whichever
// instance is already serving and reaps its workers as orphans -- five agents killed twice on
// 2026-09-01, which is why "starting aify-env is the operator's action" is a standing rule. A `run`
// that helpfully booted a daemon when it found none would turn every `--shared` on a quiet host into
// exactly that. So this asserts the refusal AND that nothing came up behind it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HOST_ONLY_ENV, forwardableEnv, startRequestFrom } from "../bin/aify-env-run.mjs";

const RUN = fileURLToPath(new URL("../bin/aify-env-run.mjs", import.meta.url));
const DISPATCHER = fileURLToPath(new URL("../bin/aify-env.mjs", import.meta.url));

/** An address on the loopback range where nothing listens and nothing can be started. */
const NOWHERE = "http://127.0.0.2:1";

/** Every ambient input sealed: this must not find the operator's environment or registry. */
function sealed(endpoint) {
  return {
    ...process.env,
    AIFY_ENV_ENDPOINT: endpoint,
    AIFY_SERVICE_REGISTRY: "/aify-tests/no-such-registry.json",
    AIFY_NO_DASHBOARD: "1",
  };
}

function runIt(script, extra = []) {
  return spawnSync(
    process.execPath,
    [script, ...extra, "--service", "aify-comms", "--launcher", "/tmp/not-a-real-launcher", "--", "--help"],
    { encoding: "utf8", timeout: 60_000, env: sealed(NOWHERE) },
  );
}

test("IT EXITS NON-ZERO when nothing answers, because the wrapper execs it", () => {
  const out = runIt(RUN);
  assert.notEqual(out.status, 0,
    "a missing environment reported success; `<wrapper> --shared` would exit 0 having started nothing");
  assert.equal(out.status, 69, "the documented refusal status changed");
});

test("AND IT SAYS WHERE IT LOOKED, so the reader can tell 'down' from 'wrong address'", () => {
  // Two different problems wear the same shape: no daemon, or AIFY_ENV_ENDPOINT pointing elsewhere.
  // A message naming neither sends somebody to restart a service that was never the one being asked.
  const out = runIt(RUN);
  const said = `${out.stdout}${out.stderr}`;
  assert.match(said, /no environment answered/, "the refusal does not say what failed");
  assert.match(said, /127\.0\.0\.2:1/, "the refusal does not name the endpoint it tried");
  assert.match(said, /Start one with/, "the refusal does not say how to fix it");
});

test("IT DOES NOT START AN ENVIRONMENT TO SATISFY ITSELF", () => {
  // THE HAZARD, and the reason this file exists rather than a bare exit-code assertion. Starting an
  // environment supersedes the incumbent and reaps its workers; a `run` that booted one on finding
  // none would make `--shared` do that on any quiet host. Nothing may be listening afterwards.
  const out = runIt(RUN);
  assert.notEqual(out.status, 0);
  const after = spawnSync(
    process.execPath,
    ["-e", `fetch(${JSON.stringify(`${NOWHERE}/health`)}).then(() => { console.log("LISTENING"); }).catch(() => { console.log("SILENT"); })`],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.match(`${after.stdout}`, /SILENT/, "something is listening now; `run` started an environment");
});

test("THE SAME REFUSAL THROUGH THE DISPATCHER, which is the path a wrapper takes", () => {
  // POSITIVE CONTROL on the route as well as the module. `<wrapper> --shared` execs `aify-env run`,
  // not `aify-env-run.mjs`, and a subcommand that never reaches its script would pass every
  // assertion above while the wrapper's own path stayed broken.
  const out = runIt(DISPATCHER, ["run"]);
  assert.equal(out.status, 69, "the dispatcher does not relay the refusal status");
  assert.match(`${out.stdout}${out.stderr}`, /no environment answered/);
});

// ── the caller's environment reaches the host ────────────────────────────────────────────────────
//
// EXTERNAL REVIEW, Round 8 H5. `startRequestFrom` built the POST with no `env`, and
// `lib/start-spec.mjs` reads `undefined` as "inherit" -- so a `--shared` session inherited the
// DAEMON's environment rather than the shell that asked for it, and ran ANONYMOUS. Worse than the
// loss: a daemon started from a shell exporting an agent id handed THAT id to every id-less shared
// session, which is the duplicate-handle shape nobody could explain.

test("the start request CARRIES the caller's environment", () => {
  const { body } = startRequestFrom({
    service: "aify-comms",
    launcher: "/usr/bin/claude-aify",
    env: { AIFY_AGENT_ID: "sc-lead", AIFY_COMMS_URL: "http://127.0.0.1:8800" },
  });
  assert.equal(body.env?.AIFY_AGENT_ID, "sc-lead",
    "the session's identity did not travel, so the host starts it as nobody");
  assert.equal(body.env?.AIFY_COMMS_URL, "http://127.0.0.1:8800");
});

test("it forwards names it has never heard of, because it knows no service", () => {
  // The file's own rule -- "IT KNOWS NO SERVICE AND NO RUNTIME" -- so this cannot be a keep-list.
  // aify-dashboard's launchers must work unchanged, and a list of what to KEEP would have to name
  // their variables.
  const { body } = startRequestFrom({
    service: "some-future-service",
    launcher: "/usr/bin/whatever",
    env: { SOME_FUTURE_SERVICE_TOKEN: "abc", HARNESS_SESSION: "s1" },
  });
  assert.equal(body.env?.SOME_FUTURE_SERVICE_TOKEN, "abc");
  assert.equal(body.env?.HARNESS_SESSION, "s1");
});

test("it does NOT forward what addresses the daemon itself", () => {
  // A caller's shell must not be able to point the host at another endpoint, registry or process
  // record. Those describe the HOST, not the process being started, and the daemon is already
  // running with the ones it chose.
  const env = forwardableEnv({
    AIFY_AGENT_ID: "sc-lead",
    AIFY_ENV_ENDPOINT: "http://evil:9999",
    AIFY_SERVICE_REGISTRY: "/tmp/other.json",
    AIFY_ENV_PROCESS_RECORD: "/tmp/other-record.json",
  });
  assert.equal(env.AIFY_AGENT_ID, "sc-lead", "the identity must still travel");
  for (const name of ["AIFY_ENV_ENDPOINT", "AIFY_SERVICE_REGISTRY", "AIFY_ENV_PROCESS_RECORD"]) {
    assert.equal(env[name], undefined, `${name} addresses the daemon and must not be forwarded`);
  }
});

test("EVERY host-only name is actually dropped, derived from the list rather than sampled", () => {
  // A three-name spot check passes while a fourth name sits in the list unenforced. The population
  // is the list itself.
  const source = Object.fromEntries(HOST_ONLY_ENV.map((name) => [name, "leaked"]));
  source.KEEP_ME = "yes";
  const env = forwardableEnv(source);
  assert.deepEqual(Object.keys(env), ["KEEP_ME"],
    `these host-only names were forwarded: ${Object.keys(env).filter((k) => k !== "KEEP_ME")}`);
});

test("an EMPTY environment is omitted, because {} would mean something else entirely", () => {
  // `undefined` means inherit; `{}` means run with NO environment. A caller with nothing to say must
  // send the first, or a shared session starts with an empty environment and fails obscurely.
  const { body } = startRequestFrom({ service: "s", launcher: "/l", env: {} });
  assert.equal("env" in body, false, "an empty env was sent as `{}`, which reads as 'no environment'");
});
