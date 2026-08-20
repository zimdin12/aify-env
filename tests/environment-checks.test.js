#!/usr/bin/env node
// The checks aify-env makes about ITSELF.
//
// Each component answers only questions about itself. These are aify-env's: can it open a terminal,
// can it read the registry, and does it still know what it owns. Nothing here inspects another
// component — that is services.mjs, and it asks.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  terminalCheck,
  registryCheck,
  ownedProcessesCheck,
  environmentCheck,
  looksLikeEnvironment,
} from "../lib/environment-checks.mjs";
import { STATE } from "../lib/health.mjs";

test("a host with a terminal passes", () => {
  assert.equal(terminalCheck({ available: true, reason: "" }).state, STATE.PASSED);
});

test("a host WITHOUT a terminal FAILS, and says what stops working", () => {
  // Not unanswered: we know the answer and it is no. And it must not read as a shrug, because a
  // terminal is what a web console needs to render a TUI at all — this is a real capability loss, not
  // an inconvenience.
  const check = terminalCheck({ available: false, reason: "node-pty did not load: MODULE_NOT_FOUND" });
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.detail, /MODULE_NOT_FOUND/);
  assert.ok(check.fix.length > 0);
});

test("a readable registry passes, naming how many services it found", () => {
  const check = registryCheck({ text: '{"version":1,"services":{"a":{"endpoint":"http://x"}}}' });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /1/);
});

test("an ABSENT registry passes: a host with no service is a legitimate host", () => {
  // The distinction that matters. Absent is not broken, and reporting it as a failure would make every
  // fresh install look damaged.
  const check = registryCheck({ text: null, missing: true });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /no services/i);
});

test("an UNREADABLE registry FAILS, because we know it is wrong", () => {
  const check = registryCheck({ text: "{not json" });
  assert.equal(check.state, STATE.FAILED);
  assert.ok(check.fix.length > 0);
});

test("a registry we could not READ AT ALL is unanswered, not failed", () => {
  // A permissions error is not the same as a corrupt file: one says the file is bad, the other says we
  // never saw it. Different remedies, so different states.
  const check = registryCheck({ readError: "EACCES" });
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /EACCES/);
});

test("owned processes pass with a count", () => {
  const check = ownedProcessesCheck({ owned: [{ id: "p1" }, { id: "p2" }], unknown: [] });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /2/);
});

test("owning nothing is a pass, not a problem", () => {
  assert.equal(ownedProcessesCheck({ owned: [], unknown: [] }).state, STATE.PASSED);
});

test("processes the reaper could not judge make this UNANSWERED", () => {
  // The reaper keeps what it cannot judge rather than reaping it, and the count has to surface
  // somewhere or that decision quietly becomes a leak nobody sees.
  const check = ownedProcessesCheck({ owned: [{ id: "p1" }], unknown: [{ id: "p1", pid: 5 }] });
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /p1|5/);
});

// A registry NEWER than this aify-env is not a broken registry.
//
// `readServices` never looked at `version`, so a v2 file was read with v1 assumptions. Both writers --
// aify-comms and aify-wrapper -- refuse a registry whose version they do not recognise, and the field
// exists precisely so a format change can be noticed. The only consumer that would have to notice one
// was the one not looking.
//
// What made this worth fixing is the ADVICE. A registry that fails to yield services is reported as
// "present but unreadable" with "Repair or remove ~/.aify/services.json". That file is SHARED: it holds
// every service's entry, and aify-comms' own writer refuses to rewrite it when unreadable for exactly
// that reason -- replacing it uninstalls other services silently. Telling the operator to delete it,
// when the file may simply be newer than we are, is the destructive half of a guess.

test("a registry declaring a NEWER version is unanswered, not read with today's assumptions", () => {
  const text = JSON.stringify({
    version: 2,
    services: { "aify-comms": { endpoint: "http://127.0.0.2:1" } },
  });
  const check = registryCheck({ text });

  assert.equal(check.state, "unanswered", `a v2 registry was reported as ${check.state}`);
  assert.match(
    `${check.detail ?? ""} ${check.reason ?? ""}`,
    /version/i,
    "the answer does not mention the version, so nobody can tell why it could not be read",
  );
});

test("a newer registry is never answered with advice to delete the shared file", () => {
  const text = JSON.stringify({ version: 2, services: {} });
  const check = registryCheck({ text });

  assert.doesNotMatch(
    `${check.fix ?? ""}`,
    /remove|delete|rm /i,
    "the remedy tells an operator to delete a registry that holds every other service's entry",
  );
});

test("a genuinely CORRUPT registry does not advise deleting the shared file either", () => {
  // The same harm, reached the other way. Repairing it is fine advice; removing it is not, because the
  // file is shared and the services whose entries vanish are not the one being diagnosed.
  const check = registryCheck({ text: "{ this is not json" });

  assert.equal(check.state, "failed", "a corrupt registry should still be a failure");
  assert.doesNotMatch(
    `${check.fix ?? ""}`,
    /\bremove\b|\bdelete\b/i,
    "the remedy still tells an operator to delete a file holding other services' entries",
  );
});

// "Something answered" is not "an environment is running", and the difference was invisible.
//
// FOUND BY RUNNING THE TOOL, not by reading it. On this host aify-doctor reported
//   ok  environment   an environment is running at http://127.0.0.1:8801
// and the TUI, one command later, said terminals were UNAVAILABLE and no processes were owned. The
// thing on 8801 is a FastAPI service belonging to something else entirely: it answers /health with a
// bare {"status":"healthy"} and 404s everything else.
//
// The doctor believed it because `knock` reports ok for ANY response -- a 404 and a 500 included -- and
// the check asked nothing beyond that. The row after it then read "0 process(es) owned by this
// environment", which is what a healthy idle environment looks like. Two green rows, no environment.
//
// This is the exact false-green this repo has paid for twice before, and health.mjs states the rule it
// breaks: a verifier whose green means "some of this was unverifiable" stops being worth running.
//
// An aify-env identifies itself by SHAPE: /health carries a processes array and a terminals object, not
// just a status string. Anything else answering there is a port collision, and the operator needs to
// know that rather than be told their environment is fine.

const envAnswer = (body, status = 200) => ({ ok: true, status, body });

const REAL = {
  status: "healthy",
  version: "0.6.0",
  processes: [],
  unknown: [],
  terminals: { available: true },
  traffic: { requests: 0, bytesOut: 0 },
};

test("a real aify-env answer passes", () => {
  const check = environmentCheck("http://127.0.0.2:1", envAnswer(REAL));
  assert.equal(check.state, STATE.PASSED);
  assert.equal(looksLikeEnvironment(envAnswer(REAL)), true);
});

test("a FOREIGN service answering /health does not pass as an environment", () => {
  // The live case. A bare status string is what the impostor on this host returns.
  const answer = envAnswer({ status: "healthy" });
  assert.equal(looksLikeEnvironment(answer), false);

  const check = environmentCheck("http://127.0.0.2:1", answer);
  assert.equal(check.state, STATE.FAILED, "a foreign service was reported as a running environment");
  assert.match(check.detail, /not an aify-env|is not/i);
  assert.ok(check.fix, "a failure must carry a remedy");
});

test("a NON-2xx answer is not an environment either", () => {
  // `knock` reports ok for any response it could parse, so without this a 404 or a 500 reads as
  // "an environment is running".
  for (const status of [404, 500, 301]) {
    assert.equal(looksLikeEnvironment(envAnswer(REAL, status)), false, `${status} passed as healthy`);
  }
});

test("nothing listening is still a failure that says to start one", () => {
  const check = environmentCheck("http://127.0.0.2:1", { ok: false, error: "ECONNREFUSED" });
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.fix, /aify-env/);
});

test("a body that is not an object at all is refused rather than probed", () => {
  for (const body of [null, "healthy", 42, []]) {
    assert.equal(looksLikeEnvironment(envAnswer(body)), false, `${JSON.stringify(body)} passed`);
  }
});

// The terminal row must say WHOSE terminal it is talking about.
//
// Seen side by side on this host: the doctor said "a real terminal is available for processes that
// need one" while the TUI, reading the environment's own /health, said terminals were UNAVAILABLE.
// Both were right about different subjects. The doctor loads node-pty in ITS OWN process; the
// environment that will actually spawn agents answers for itself, and it need not be the same install,
// the same node, or the same machine state.
//
// "for processes that need one" reads as a promise about the agents. It is a fact about the doctor.
// Naming the subject costs a few words and removes a contradiction an operator would otherwise have to
// resolve by reading two codebases.

test("the terminal row says where it was measured, not just what it found", () => {
  const check = terminalCheck({ available: true });
  assert.equal(check.state, STATE.PASSED);
  assert.match(
    check.detail,
    /this process|this host/i,
    "the detail promises something about spawned processes that it did not measure",
  );
});
