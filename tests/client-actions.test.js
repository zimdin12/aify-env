#!/usr/bin/env node
// What a client does when the operator confirms an action.
//
// THIS EXISTS BECAUSE THE ENTRYPOINT CANNOT BE TESTED. Importing `bin/aify-env-tui.mjs` STARTS a view
// that talks to a daemon, so logic written there can only be READ, never exercised -- and a source
// regex proves a line was written, which is not the same as proving it does the right thing. The
// entrypoint is now one wiring line and the decisions are here.

import assert from "node:assert/strict";
import test from "node:test";

import { CLIENT_ACTIONS, performClientAction } from "../lib/client-actions.mjs";

/** A fetch that records what it was asked and answers however the test needs. */
function recordingFetch({ ok = true, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method, redirect: options?.redirect });
      if (throws) throw new Error("connection refused");
      return { ok };
    },
  };
}

test("POSITIVE CONTROL: a confirmed stop reaches the daemon", async () => {
  // Every "nothing was sent" assertion below would pass against a function that never sends anything.
  const f = recordingFetch();
  const sent = await performClientAction(
    { action: "stop", process: { id: "abc-p1" } },
    { endpoint: "http://127.0.0.1:8802", fetchImpl: f.impl },
  );
  assert.equal(sent, true);
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]),
    [["DELETE", "http://127.0.0.1:8802/processes/abc-p1"]]);
});

test("ONLY `stop` REACHES THE WIRE, because a verb that becomes a stop is the worst kind of wrong", async () => {
  // `attach` is the view's own business -- it moves the keyboard and touches no daemon -- and
  // `restart` is nobody's here, since respawning a managed agent is the service's work. A dispatcher
  // running its one branch for every action is how a future verb silently becomes a stop.
  const f = recordingFetch();
  for (const action of ["attach", "restart", "detonate", "", null, undefined]) {
    await performClientAction({ action, process: { id: "abc-p1" } },
      { endpoint: "http://x", fetchImpl: f.impl });
  }
  assert.deepEqual(f.calls, [], `${f.calls.length} request(s) were sent for actions that are not stop`);
});

test("NO TARGET SENDS NOTHING, rather than deleting a URL with an empty id", async () => {
  // `/processes/` with no id is a different route, and a DELETE aimed at it is a request nobody
  // intended. Absent, empty and non-string ids are all the same answer: do not send.
  const f = recordingFetch();
  for (const process of [undefined, null, {}, { id: "" }, { id: null }]) {
    await performClientAction({ action: "stop", process }, { endpoint: "http://x", fetchImpl: f.impl });
  }
  assert.deepEqual(f.calls, []);
});

test("THE ID IS ENCODED, so an id with a slash cannot address another route", async () => {
  const f = recordingFetch();
  await performClientAction({ action: "stop", process: { id: "a/b?c" } },
    { endpoint: "http://x", fetchImpl: f.impl });
  assert.equal(f.calls[0].url, "http://x/processes/a%2Fb%3Fc");
});

test("A REDIRECT IS NEVER FOLLOWED, because a DELETE is not a request to repeat elsewhere", async () => {
  // The same rule every other request in this product follows: `fetch` re-sends on a 302, and a
  // delete aimed at an address nobody chose is worse than a delete that failed.
  const f = recordingFetch();
  await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x", fetchImpl: f.impl });
  assert.equal(f.calls[0].redirect, "manual");
});

test("A TRAILING SLASH ON THE ENDPOINT DOES NOT DOUBLE UP", async () => {
  const f = recordingFetch();
  await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x:8802///", fetchImpl: f.impl });
  assert.equal(f.calls[0].url, "http://x:8802/processes/p1");
});

test("IT NEVER THROWS, because this runs inside a keyboard handler", async () => {
  // A request that did not land must not take the operator's screen down. A failed stop shows as the
  // process still being listed on the next refresh, which is the honest signal.
  const refused = recordingFetch({ throws: true });
  assert.equal(await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x", fetchImpl: refused.impl }), false);

  const rejected = recordingFetch({ ok: false });
  assert.equal(await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x", fetchImpl: rejected.impl }), false,
    "a non-ok response was reported as a successful stop");
});

test("the client offers what it can perform, and restart is not on that list", () => {
  // Absent from BOTH tiers. The daemon cannot restart a managed agent either -- neither has a
  // primitive for it -- so offering it anywhere would be a menu row that does nothing when chosen.
  assert.deepEqual([...CLIENT_ACTIONS], ["attach", "stop"]);
});

console.log("client-actions.test.js: all assertions passed");
