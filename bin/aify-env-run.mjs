#!/usr/bin/env node
// Start a program HERE and attach this terminal to it, in one step.
//
//   aify-env run --service aify-comms --launcher /path/to/claude-aify --label sc-lead -- --resume abc
//
// WHAT IT IS FOR. A launcher that wants its session to outlive the terminal that started it: the
// process becomes this environment's, so closing the window leaves it running and anyone can attach
// again later. That is v0.6.2's headline -- `claude-aify --shared` is one line calling this.
//
// WHY IT LIVES HERE rather than in the wrapper package. A rendered launcher is a standalone shell
// script; it cannot import a node module out of a package it does not know the path of. It CAN call
// a command on PATH, and `aify-env` already is one. Building this in aify-wrapper produced a module
// with no caller -- a working, tested, unreachable implementation, which is the defect this project
// has found four times in two days and had just written down.
//
// IT KNOWS NO SERVICE AND NO RUNTIME. The service is a string the caller supplies, the launcher is a
// path, and the arguments are opaque. aify-dashboard's launchers will call this unchanged; nothing
// in this file would tell you which service asked.
//
// START AND ATTACH ARE SEPARATE FACTS. If the start succeeds and the attach fails, the process is
// RUNNING and the operator must be told its id rather than left thinking nothing happened -- that is
// the whole promise of hosting it here, and the one moment it would be easy to break.

import { fileURLToPath } from "node:url";

const LF = String.fromCharCode(10);
const ENDPOINT = process.env.AIFY_ENV_ENDPOINT || "http://127.0.0.1:8802";
const say = (text) => process.stderr.write(`${text}${LF}`);

/** `--k v` pairs before a bare `--`; everything after it is the program's own. */
export function parseRunArgs(argv = []) {
  const args = (Array.isArray(argv) ? argv : []).map(String);
  const at = args.indexOf("--");
  const head = at >= 0 ? args.slice(0, at) : args;
  const rest = at >= 0 ? args.slice(at + 1) : [];
  const named = {};
  for (let i = 0; i < head.length; i += 1) {
    const key = head[i];
    if (!key.startsWith("--")) continue;
    // `--key=value` and `--key value` both, because a shell writes whichever is convenient and a
    // launcher that guessed wrong would pass the value as a program argument.
    if (key.includes("=")) {
      named[key.slice(2, key.indexOf("="))] = key.slice(key.indexOf("=") + 1);
    } else {
      named[key.slice(2)] = head[i + 1] ?? "";
      i += 1;
    }
  }
  return { ...named, args: rest };
}

/**
 * The body for `POST /processes`, or why it cannot be built.
 *
 * FAILS CLOSED ON BOTH REQUIRED FIELDS, separately. They are substituted into a launcher at render
 * time, so an empty one means the launcher was rendered wrong -- and without this the failure
 * arrives as a 400 from the host, which reads like the host is the broken thing.
 */
/**
 * Variables that address or configure THIS DAEMON, and are therefore never forwarded to it.
 *
 * The test for membership is one question, not a judgement per name: does this variable describe the
 * HOST, or the process being started? A caller's shell must not be able to point the daemon at
 * another endpoint, another service registry, or another process record -- the daemon is already
 * running with the ones it chose, and a forwarded copy would either be ignored or, worse, obeyed.
 *
 * Everything else travels, including variables this file has never heard of. That is deliberate: it
 * knows no service and no runtime, and a list of what to KEEP would have to name them.
 */
export const HOST_ONLY_ENV = Object.freeze([
  "AIFY_ENV_ENDPOINT",
  "AIFY_ENV_PROCESS_RECORD",
  "AIFY_SERVICE_REGISTRY",
  "AIFY_ADVERTISE",
  "AIFY_NO_DASHBOARD",
  "AIFY_TUI_REFRESH_MS",
]);

/** The caller's environment as the host should reproduce it: everything except the host's own. */
export function forwardableEnv(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (HOST_ONLY_ENV.includes(key)) continue;
    if (value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

export function startRequestFrom({ service, launcher, label = "", cwd = "", args = [], env = null } = {}) {
  const owner = String(service ?? "").trim();
  const path = String(launcher ?? "").trim();
  if (!path) return { error: "run needs --launcher, the program to start" };
  if (!owner) return { error: "run needs --service, because every process here has an owner" };
  const body = {
    service: owner,
    launcher: path,
    args: (Array.isArray(args) ? args : []).map(String),
    cwd: String(cwd || ""),
  };
  // THE CALLER'S ENVIRONMENT TRAVELS, since 2026-09-04 (external review, Round 8 H5).
  //
  // This body carried no `env`, and `lib/start-spec.mjs` reads `undefined` as "inherit" -- so a
  // shared session inherited the DAEMON's environment instead of the shell that asked for it. Every
  // fact that identifies the session was lost: the agent id, the endpoint, the credential, the
  // harness carriers. A `--shared` session therefore ran ANONYMOUS, which is the launch-identity gap
  // this project already keeps a doctor row for.
  //
  // AND THE LOSS WAS NOT THE WORST OF IT. A daemon started from a shell that exports an agent id
  // handed THAT identity to every id-less shared session, so two sessions claimed one id -- the
  // duplicate-handle shape `session-handles` reports and nobody could explain.
  //
  // Omitted when empty, so "inherit" stays expressible and a caller with nothing to say does not
  // send `{}` -- which start-spec would read as "run with an EMPTY environment", a different and
  // much worse instruction.
  const forwarded = env && typeof env === "object" && !Array.isArray(env) ? env : null;
  if (forwarded && Object.keys(forwarded).length > 0) body.env = forwarded;
  // OMITTED RATHER THAN EMPTY: the host renders this in its AGENT column, and a blank string there
  // reads as a process nobody owns rather than one not yet named.
  const named = String(label ?? "").trim();
  if (named) body.label = named;
  return { body };
}

// Reached only when run as a command; importing this for its parsers must not start anything.
if (process.argv[1] && process.argv[1].endsWith("aify-env-run.mjs")) {
  const parsed = parseRunArgs(process.argv.slice(2));
  const built = startRequestFrom({
    ...parsed,
    cwd: parsed.cwd || process.cwd(),
    // The shell that ran this command, minus what belongs to the daemon. See `forwardableEnv`.
    env: forwardableEnv(process.env),
  });
  if (built.error) {
    say(`aify-env run: ${built.error}`);
    process.exit(64);
  }

  let started;
  try {
    const response = await fetch(`${ENDPOINT}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(20000),
    });
    const answered = await response.json().catch(() => null);
    if (response.status !== 201) {
      // THE HOST'S OWN WORDS. It refuses a launcher that carries no wrapper marker, and relaying
      // "start failed" instead of that reason sends the reader to the wrong file.
      say(`aify-env run: the environment refused to start it (${response.status}): `
        + `${answered?.error ?? answered?.detail ?? "no reason given"}`);
      process.exit(70);
    }
    started = answered;
  } catch (error) {
    say(`aify-env run: no environment answered at ${ENDPOINT} (${error?.message ?? error}).`);
    say("  Start one with `aify-env`, or point AIFY_ENV_ENDPOINT at the right host.");
    process.exit(69);
  }

  // IT IS RUNNING NOW, whatever happens next. Said before attaching, so a failure to attach leaves
  // the operator holding the id rather than believing nothing started.
  say(`started ${parsed.label || started.id} here (${started.id}); it will outlive this terminal.`);

  // THE SAME CLIENT the `attach` subcommand runs -- argv is rewritten the way the dispatcher does it,
  // so there is one attach implementation rather than a second that drifts.
  process.argv = [
    process.argv[0],
    fileURLToPath(new URL("./aify-env-attach.mjs", import.meta.url)),
    started.id,
  ];
  await import("./aify-env-attach.mjs");
}
