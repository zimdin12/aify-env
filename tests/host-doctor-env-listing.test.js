// Ported from aify-comms `mcp/stdio/tests/the-settings-two-live-readers-ask.test.js` in 0.9.7, when this row moved to `aify-env doctor`.
// `envListing` reads a process listing out of what aify-env answers, and keeps a REFUSED listing and an
// unreadable one apart from an empty one: the `env-processes` row turns the first two into unknown and
// only the third into a real comparison.

import assert from "node:assert/strict";
import test from "node:test";

import { envListing } from "../lib/plugins/aify-comms/env-process-reconciliation.mjs";

test("a REFUSED listing is not an empty one", () => {
  // The distinction this module was written for: a host that refused to answer and a host running
  // nothing are different facts, and reporting the first as the second is how an unreachable
  // environment reads as a healthy idle one.
  assert.deepEqual(envListing({ ok: false }), { processes: null, refused: true });
});

test("an UNREADABLE shape is not an empty listing either", () => {
  // Neither a refusal nor a list: nothing was learned, and `processes: null` says so.
  for (const shape of [undefined, null, {}, { handle: {} }, { handle: { processes: "no" } }, 7]) {
    const listing = envListing(shape);
    assert.equal(listing.processes, null, `${JSON.stringify(shape)} should yield no listing`);
    assert.equal(listing.refused, false, "only an explicit refusal is a refusal");
  }
});

test("both shapes a host can answer with are read the same way", () => {
  // The caller should not have to know whether it got a bare array or a `processes` key.
  const rows = [{ pid: 1 }, { pid: 2 }];
  assert.deepEqual(envListing(rows), { processes: rows, refused: false });
  assert.deepEqual(envListing({ handle: rows }), { processes: rows, refused: false });
  assert.deepEqual(envListing({ handle: { processes: rows } }), { processes: rows, refused: false });
  assert.deepEqual(envListing({ processes: rows }), { processes: rows, refused: false });
});

test("an EMPTY listing is a real answer, distinct from no listing", () => {
  // The control for the two tests above: a host that answered "nothing running" must not be reported
  // as one that could not be read.
  const listing = envListing({ handle: { processes: [] } });
  assert.deepEqual(listing.processes, []);
  assert.equal(listing.refused, false);
  assert.notEqual(listing.processes, null, "an empty list collapsed into `could not tell`");
});
