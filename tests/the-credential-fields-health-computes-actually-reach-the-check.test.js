#!/usr/bin/env node
// The three advertise fields `/health` computes must survive the trip to the doctor that reads them.
//
// MEASURED ON THE OPERATOR'S HOST, 2026-09-06. `aify-env doctor` showed:
//
//     ??  advertise-cred  this aify-env is running but does not report its advertisement
//                         credentials, so whether it holds one is unknown — restart it on a build
//                         that does
//
// There is no such build. `bin/aify-env.mjs` computes `advertisingEnabled`, `advertiseCredentials`
// and `advertiseAttempts` and passes all three as deps; the `/health` route in `lib/protocol.mjs`
// forwarded `advertising` and `advertisingTo` and let the other three fall on the floor. So
// `environment-report.mjs` read `body.advertiseCredentials`, got `undefined`, and the check reported
// `??` on every host that has ever run this daemon.
//
// THE ADVICE IS THE EXPENSIVE HALF. Restarting aify-env supersedes the running instance and reaps
// its managed workers -- so a row that cannot be satisfied was telling the operator to pay that
// price for nothing, every time they looked.
//
// A PRODUCER AND A READER POINTED AT DIFFERENT CARRIERS, with a middle layer that drops the field.
// Both ends had tests and both were green, because each test supplied the other side itself. That is
// exactly why this drives the REAL route into the REAL check: the only thing neither unit test could
// see is the wire between them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest } from "../lib/protocol.mjs";
import { advertiseCredentialCheck } from "../lib/environment-checks.mjs";

const RUNNER = {
  list: () => [],
  instance: () => "i-1",
  history: () => ({ startedTotal: 0, lastExitAtMs: null }),
};

/** `/health` as the daemon actually calls it, with the deps `bin/aify-env.mjs` supplies. */
async function health(extra = {}) {
  const response = await handleRequest(
    { method: "GET", path: "/health", body: null },
    { runner: RUNNER, readFile: () => "", version: "0.6.2", build: "b1", codeOnDisk: "b1", ...extra },
  );
  return response.body;
}

/** The doctor's own read, copied from `environment-report.mjs` so the field names are pinned too. */
const checkFrom = (body) => advertiseCredentialCheck({
  answered: true,
  enabled: body?.advertisingEnabled ?? null,
  credentials: body?.advertiseCredentials ?? null,
  attempts: body?.advertiseAttempts ?? null,
});

test("POSITIVE CONTROL: a field that already travelled still travels", async () => {
  // Every assertion below is "this key is on the body". A handler that returned nothing at all would
  // satisfy the defect's shape while proving the instrument, not the fix.
  const body = await health({ advertisingTo: { "aify-comms": { fresh: true } } });
  assert.deepEqual(body.advertisingTo, { "aify-comms": { fresh: true } });
});

test("THE DEFECT: the three advertise fields reach the body", async () => {
  const body = await health({
    advertisingEnabled: true,
    advertiseCredentials: { "aify-comms": { hasCredential: true, keyEnv: ["AIFY_API_KEY"] } },
    advertiseAttempts: { "aify-comms": { ok: true } },
  });
  assert.equal(body.advertisingEnabled, true, "the daemon computed this and /health dropped it");
  assert.deepEqual(body.advertiseCredentials, {
    "aify-comms": { hasCredential: true, keyEnv: ["AIFY_API_KEY"] },
  });
  assert.deepEqual(body.advertiseAttempts, { "aify-comms": { ok: true } });
});

test("THE WHOLE POINT: the check can now answer, instead of reading ?? forever", async () => {
  const body = await health({
    advertisingEnabled: true,
    advertiseCredentials: { "aify-comms": { hasCredential: true, keyEnv: ["AIFY_API_KEY"] } },
    advertiseAttempts: { "aify-comms": { ok: true } },
  });
  const check = checkFrom(body);
  assert.notEqual(
    check.state, "unanswered",
    "the doctor still cannot see the credential the daemon reported, so advertise-cred keeps "
    + "telling the operator to restart a daemon that would come back identical",
  );
  assert.equal(check.state, "passed");
});

test("a REFUSED credential now reaches the doctor as a failure, not as a shrug", async () => {
  // The case the row exists for, and the one an `??` was hiding: a daemon whose every advertisement
  // is rejected looks identical to a healthy one from every other signal.
  const body = await health({
    advertisingEnabled: true,
    advertiseCredentials: { "aify-comms": { hasCredential: false, keyEnv: ["AIFY_API_KEY"] } },
    // A 401 is the service saying our key is wrong or absent, which `advertiseAttemptCause` reads as
    // `refused-credential`. The shape comes from that function rather than from my guess: an invented
    // fixture proves the fix against a daemon that does not exist.
    advertiseAttempts: { "aify-comms": { status: 401 } },
  });
  const check = checkFrom(body);
  assert.equal(check.state, "failed");
  assert.match(check.detail, /AIFY_API_KEY/, "the remedy must name the variable to set");
});

test("a daemon that reports nothing is UNANSWERED, not a pass", async () => {
  // NEGATIVE CONTROL, and the reason the defaults are `null` rather than `false`/`{}`. An older
  // daemon has said nothing; defaulting `advertisingEnabled` to false would read as "advertising is
  // off, so no credential is needed" -- a PASS -- and would hide exactly the host this row is for.
  const body = await health();
  assert.equal(body.advertisingEnabled, null);
  assert.equal(body.advertiseCredentials, null);
  assert.equal(checkFrom(body).state, "unanswered");
});

test("advertising switched OFF is a pass, not a failure", async () => {
  // AIFY_ADVERTISE=0 hands the job back to the bridge deliberately. Reporting a missing credential
  // there would fail a host configured exactly as intended.
  const body = await health({
    advertisingEnabled: false,
    advertiseCredentials: { "aify-comms": { hasCredential: false, keyEnv: ["AIFY_API_KEY"] } },
  });
  assert.equal(checkFrom(body).state, "passed");
});
