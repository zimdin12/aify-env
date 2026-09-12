// An empty service registry is a configuration; a damaged one is a fault. They are told apart.
//
// THE DEFECT THIS EXISTS FOR. `registryCheck` inferred "did not parse" from "readServices returned
// nothing", and reported a perfectly valid `{"version":1,"services":{}}` as
//
//   FAIL  registry  the service registry is present but unreadable, so no service can be located
//
// with a remedy telling the operator to repair a file that was exactly as intended. The operator read
// that row off a dedicated `herdr-aify` instance -- which aify-env ADMITS ONLY with an explicitly
// empty registry (the scoped-service contract in `instance-bootstrap.mjs`). So the single most
// common way to reach this row was the one case where nothing was wrong, and the check sent the
// person looking for damage that did not exist.
//
// The inference is sound only for text that actually declares services, which is what the split
// below measures.

import test from "node:test";
import assert from "node:assert/strict";

import { registryCheck } from "../lib/environment-checks.mjs";

test("a valid but empty registry PASSES, and never advises a repair", () => {
  const answer = registryCheck({ text: JSON.stringify({ version: 1, services: {} }) });
  assert.equal(answer.state, "passed", "an empty registry was reported as a fault");
  assert.doesNotMatch(answer.detail, /unreadable/);
  assert.equal(answer.fix, "", "an operator was told to repair a file that is exactly as intended");
});

test("POSITIVE CONTROL: damaged text still FAILS, with the repair that does not lose other services", () => {
  // Without this, a check that passed everything would satisfy the test above and the real fault
  // would go unreported.
  for (const text of ["{ not json", '{"version":1,"services":[]}', '{"version":1}']) {
    const answer = registryCheck({ text });
    assert.equal(answer.state, "failed", `damaged registry text was reported as fine: ${text}`);
    assert.match(answer.detail, /unreadable/);
  }
});

test("a registry with services still reports them", () => {
  const answer = registryCheck({ text: JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://x" } } }) });
  assert.equal(answer.state, "passed");
  assert.match(answer.detail, /aify-comms/);
});

test("absent and unreadable keep their own distinct answers", () => {
  assert.equal(registryCheck({ missing: true }).state, "passed", "a host with no services is legitimate");
  // Never seen is a permissions problem, not a content problem, and must not read as either pass or fail.
  const unread = registryCheck({ readError: "EACCES" });
  assert.match(unread.detail, /could not read/);
});
