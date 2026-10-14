// A registry entry's `keyEnv` names a variable; an Object.prototype member is not one (0.9.7 review).
//
// THE BUG. `keyEnv` is whatever a service wrote into the shared registry, and `process.env` inherits from
// Object.prototype. `env["toString"]` is a function, so `credentialFor` stringified it and the advertiser sent
// `function toString() { [native code] }` as X-API-Key -- to the service, on every beat. Both resolvers now read a
// name only when it is the environment's own; an inherited one is a variable that is not set.
//
// THE REAL OBJECT, because a stand-in would not prove it: `process.env` is what the daemon passes, and on Windows its
// own-property answer is case-insensitive like its reads. The control variable is set for the test and removed after;
// its name is this test's own and names nothing any component reads.

import assert from "node:assert/strict";
import test from "node:test";

import { advertiseTo, advertisementTargets, advertisingChoice, credentialFor } from "../lib/advertise.mjs";
import { credentialForTarget } from "../lib/credential-resolve.mjs";
import { CREDENTIAL_ABSENT, CREDENTIAL_OK } from "../lib/credential-store.mjs";
import { advertisementPathFor } from "../lib/plugins/index.mjs";
import { postAdvertisement } from "../lib/post-advertisement.mjs";
import { readServices } from "../lib/services.mjs";

const CONTROL = "INHERITED_NAME_TEST_REAL_KEY";
const KEY = "real-key-0123456789abcdef";
const INHERITED = ["toString", "constructor", "__proto__", "valueOf"];

/** One entry per inherited name and the control, each declaring a route so each is beaten. Raw JSON: `__proto__`. */
function registry() {
  const entries = [...INHERITED, CONTROL].map((variable, index) =>
    `"svc-${index}":{"endpoint":"http://127.0.0.1:91${index}0","keyEnv":["${variable}"],"advertisement":{"path":"/beat"}}`);
  return readServices(`{"version":1,"services":{${entries.join(",")}}}`);
}

/** One heartbeat pass through the real transport, returning the X-API-Key each service was sent ("" for none). */
async function keysOnTheWire(credential) {
  const targets = advertisementTargets(advertisingChoice(registry()).advertised, advertisementPathFor);
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push([url, options.headers["X-API-Key"] ?? ""]); return new Response(null, { status: 204 }); };
  await advertiseTo({
    targets, body: {}, env: process.env, credential,
    post: (url, body, key, name) => postAdvertisement(url, body, key, name, { proofFor: () => "", fetchImpl }),
  });
  return sent;
}

const EXPECTED = [...INHERITED.map(() => ""), KEY];

test("an inherited keyEnv name sends no key on a real beat; the set control sends its own", async (t) => {
  process.env[CONTROL] = KEY;
  t.after(() => { delete process.env[CONTROL]; });
  assert.equal(typeof process.env.toString, "function", "process.env no longer inherits, so this proves nothing");
  // The environment-only reader (`credentialFor`, advertiseTo's default) and the store-aware one the daemon passes.
  const environmentOnly = await keysOnTheWire(undefined);
  const storeAware = await keysOnTheWire(async (target) => (await credentialForTarget(target, { env: process.env })).value);
  for (const sent of [environmentOnly, storeAware]) {
    assert.equal(sent.length, 5, "every entry is beaten, so a missing key is the resolver's answer and not a skipped beat");
    assert.deepEqual(sent.map(([, key]) => key), EXPECTED);
  }
});

test("an inherited keyEnv name reads as an unset variable in both resolvers", async (t) => {
  process.env[CONTROL] = KEY;
  t.after(() => { delete process.env[CONTROL]; });
  for (const name of INHERITED) {
    assert.equal(credentialFor({ keyEnv: [name] }, process.env), "", name);
    const answer = await credentialForTarget({ keyEnv: [name] }, { env: process.env });
    assert.deepEqual([answer.state, answer.value, answer.source], [CREDENTIAL_ABSENT, "", ""], name);
  }
  // The control, and the first-set-name-wins order kept when an inherited name comes first.
  assert.equal(credentialFor({ keyEnv: ["toString", CONTROL] }, process.env), KEY);
  const answer = await credentialForTarget({ keyEnv: ["toString", CONTROL] }, { env: process.env });
  assert.deepEqual([answer.state, answer.value, answer.source], [CREDENTIAL_OK, KEY, "env"]);
});
